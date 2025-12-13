const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const {
  authorize,
  invalidatePermissionCache,
} = require("../middleware/permissionMiddleware");

const { ensureRbacSchema } = require("../utils/rbacSetup");

const router = express.Router();

ensureRbacSchema().catch((error) => {
  console.warn("RBAC bootstrap skipped:", error.message || error);
});

const assertAdminOrPermission = async (req, res, next) => {
  if (req.user?.role === "admin") {
    return next();
  }
  return authorize("permissions", "manage")(req, res, next);
};

const fetchPermissions = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT id, module, action, label, description, created_at, updated_at
        FROM permissions
        ORDER BY module, action
      `
    );
    res.json(rows);
  } catch (error) {
    console.error("Failed to fetch permissions:", error);
    res.status(500).json({ error: "Failed to fetch permissions" });
  }
};

const upsertPermission = async ({ module, action, label, description }) => {
  const query = `
    INSERT INTO permissions (module, action, label, description)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (module, action)
    DO UPDATE SET label = EXCLUDED.label,
                  description = EXCLUDED.description,
                  updated_at = NOW()
    RETURNING id
  `;
  const { rows } = await pool.query(query, [
    module.toLowerCase(),
    action.toLowerCase(),
    label || null,
    description || null,
  ]);
  return rows[0].id;
};

const syncRolePermissions = async (roleId, permissions, actorId) => {
  await pool.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);

  if (!permissions || permissions.length === 0) {
    return;
  }

  await pool.query(
    `
      INSERT INTO role_permissions (role_id, permission_id, granted_at, granted_by)
      SELECT $1, perm_id, NOW(), $3
      FROM UNNEST($2::int[]) AS perm_id
      ON CONFLICT DO NOTHING
    `,
    [roleId, permissions, actorId ?? null]
  );
};

const syncUserRoles = async (userId, roles, actorId) => {
  await pool.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
  if (!roles || roles.length === 0) return;

  await pool.query(
    `
      INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
      SELECT $1, role_id, NOW(), $3
      FROM UNNEST($2::int[]) AS role_id
      ON CONFLICT DO NOTHING
    `,
    [userId, roles, actorId ?? null]
  );
};

const syncUserPermissions = async (userId, permissions, actorId) => {
  await pool.query("DELETE FROM user_permissions WHERE user_id = $1", [userId]);
  if (!permissions || permissions.length === 0) return;

  const payload = permissions
    .map((entry) => {
      const permissionId = Number(entry.permissionId);
      if (!Number.isFinite(permissionId)) {
        return null;
      }

      const cityId =
        entry.cityId === null ||
          entry.cityId === undefined ||
          entry.cityId === "*" ||
          entry.cityId === ""
          ? null
          : Number(entry.cityId);

      if (cityId !== null && !Number.isFinite(cityId)) {
        return null;
      }

      return {
        permission_id: permissionId,
        city_id: cityId,
      };
    })
    .filter(Boolean);

  if (!payload.length) {
    return;
  }

  await pool.query(
    `
      INSERT INTO user_permissions (user_id, permission_id, city_id, granted_at, granted_by)
      SELECT
        $1,
        (data->>'permission_id')::int,
        CASE
          WHEN data->>'city_id' IS NULL OR data->>'city_id' = '' THEN NULL
          ELSE (data->>'city_id')::int
        END,
        NOW(),
        $2
      FROM jsonb_array_elements($3::jsonb) AS data
      ON CONFLICT DO NOTHING
    `,
    [userId, actorId ?? null, JSON.stringify(payload)]
  );
};

const normalizePermissionAssignments = async (permissions = []) => {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return [];
  }

  const assignments = [];
  for (const perm of permissions) {
    if (perm === null || perm === undefined) {
      continue;
    }

    if (typeof perm === "number") {
      assignments.push({ permissionId: perm, cityId: null });
      continue;
    }

    if (typeof perm === "object") {
      let permissionId = null;
      if (perm.id || perm.permission_id || perm.permissionId) {
        const numeric = Number(perm.id ?? perm.permission_id ?? perm.permissionId);
        if (Number.isFinite(numeric)) {
          permissionId = numeric;
        }
      } else if (perm.module && perm.action) {
        const createdId = await upsertPermission({
          module: perm.module,
          action: perm.action,
          label: perm.label,
          description: perm.description,
        });
        permissionId = createdId;
      }

      if (!Number.isFinite(permissionId)) {
        continue;
      }

      const rawCity = perm.city_id ?? perm.cityId ?? perm.city ?? null;
      let cityId = null;
      if (
        rawCity !== null &&
        rawCity !== undefined &&
        rawCity !== "" &&
        rawCity !== "*" &&
        rawCity !== "ALL"
      ) {
        const numericCity = Number(rawCity);
        cityId = Number.isFinite(numericCity) ? numericCity : null;
      }

      assignments.push({ permissionId, cityId });
    }
  }

  return assignments;
};

const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Permission routes
router.get("/permissions", authenticate, assertAdminOrPermission, fetchPermissions);

router.post("/permissions", authenticate, assertAdminOrPermission, async (req, res) => {
  try {
    const { module, action, label, description } = req.body || {};
    if (!module || !action) {
      return res.status(400).json({ error: "module and action are required" });
    }
    const id = await upsertPermission({ module, action, label, description });
    invalidatePermissionCache();
    res.status(201).json({ id });
  } catch (error) {
    console.error("Failed to upsert permission:", error);
    res.status(500).json({ error: "Failed to upsert permission" });
  }
});

// Role routes
router.get("/roles", authenticate, assertAdminOrPermission, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT r.id,
               r.name,
               r.description,
               r.is_system,
               r.created_at,
               r.updated_at,
               COALESCE(
                 json_agg(
                   DISTINCT jsonb_build_object(
                     'id', p.id,
                     'module', p.module,
                     'action', p.action,
                     'label', p.label
                   )
                 ) FILTER (WHERE p.id IS NOT NULL),
                 '[]'
               ) AS permissions
        FROM roles r
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p ON p.id = rp.permission_id
        GROUP BY r.id
        ORDER BY r.is_system DESC, r.name ASC
      `
    );
    res.json(rows);
  } catch (error) {
    console.error("Failed to fetch roles:", error);
    res.status(500).json({ error: "Failed to fetch roles" });
  }
});

router.post("/roles", authenticate, assertAdminOrPermission, async (req, res) => {
  try {
    const { name, description, permissions } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: "Role name is required" });
    }

    const roleResult = await pool.query(
      `
        INSERT INTO roles (name, description, is_system)
        VALUES ($1, $2, FALSE)
        ON CONFLICT (name)
        DO UPDATE SET description = EXCLUDED.description, updated_at = NOW()
        RETURNING id
      `,
      [name.trim().toLowerCase(), description || null]
    );

    const roleId = roleResult.rows[0].id;

    let permissionIds = [];
    if (Array.isArray(permissions) && permissions.length > 0) {
      const ids = await Promise.all(
        permissions.map((perm) =>
          typeof perm === "number"
            ? perm
            : upsertPermission({
              module: perm.module,
              action: perm.action,
              label: perm.label,
              description: perm.description,
            })
        )
      );
      permissionIds = ids;
    }

    await syncRolePermissions(roleId, permissionIds, req.user?.user_id);
    invalidatePermissionCache();
    res.status(201).json({ id: roleId });
  } catch (error) {
    console.error("Failed to create role:", error);
    res.status(500).json({ error: "Failed to create role" });
  }
});

router.put("/roles/:roleId", authenticate, assertAdminOrPermission, async (req, res) => {
  const { roleId } = req.params;
  const { name, description, permissions } = req.body || {};

  try {
    const roleResult = await pool.query(
      `
        UPDATE roles
        SET name = COALESCE($2, name),
            description = COALESCE($3, description),
            updated_at = NOW()
        WHERE id = $1 AND is_system = FALSE
        RETURNING id
      `,
      [roleId, name ? name.trim().toLowerCase() : null, description || null]
    );

    if (roleResult.rowCount === 0) {
      return res.status(404).json({ error: "Role not found or system role" });
    }

    let permissionIds = [];
    if (Array.isArray(permissions)) {
      const ids = await Promise.all(
        permissions.map((perm) =>
          typeof perm === "number"
            ? perm
            : upsertPermission({
              module: perm.module,
              action: perm.action,
              label: perm.label,
              description: perm.description,
            })
        )
      );
      permissionIds = ids;
      await syncRolePermissions(roleId, permissionIds, req.user?.user_id);
    }

    invalidatePermissionCache();
    res.json({ id: roleId });
  } catch (error) {
    console.error("Failed to update role:", error);
    res.status(500).json({ error: "Failed to update role" });
  }
});

router.delete("/roles/:roleId", authenticate, assertAdminOrPermission, async (req, res) => {
  const { roleId } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM roles WHERE id = $1 AND is_system = FALSE",
      [roleId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Role not found or system role" });
    }
    invalidatePermissionCache();
    res.status(204).send();
  } catch (error) {
    console.error("Failed to delete role:", error);
    res.status(500).json({ error: "Failed to delete role" });
  }
});

// User management routes
router.get("/users", authenticate, assertAdminOrPermission, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT
          u.user_id,
          u.name,
          u.email,
          u.phone,
          u.emp_code,
          u.role,
          u.department,
          json_build_object(
            'roles',
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
              FILTER (WHERE r.id IS NOT NULL),
              '[]'
            ),
            'permissions',
            COALESCE(
              json_agg(
                DISTINCT jsonb_build_object(
                  'id', p.id,
                  'module', p.module,
                  'action', p.action,
                  'label', p.label,
                  'city_id', up.city_id,
                  'city_name', ci.city_name
                )
              ) FILTER (WHERE p.id IS NOT NULL),
              '[]'
            )
          ) AS access
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.user_id
        LEFT JOIN roles r ON r.id = ur.role_id
        LEFT JOIN user_permissions up ON up.user_id = u.user_id
        LEFT JOIN permissions p ON p.id = up.permission_id
        LEFT JOIN cities ci ON ci.city_id = up.city_id
        GROUP BY u.user_id
        ORDER BY u.user_id DESC
      `
    );

    res.json(rows);
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

router.post("/users", authenticate, assertAdminOrPermission, async (req, res) => {
  const {
    name,
    emp_code,
    email,
    phone,
    department,
    password,
    roles,
    permissions,
  } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const userResult = await pool.query(
      `
        INSERT INTO users (name, emp_code, email, phone, role, department, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
        RETURNING user_id
      `,
      [
        name,
        emp_code || null,
        email.toLowerCase(),
        phone || null,
        Array.isArray(roles) && roles.length > 0 ? "custom" : "user",
        department || null,
        hashedPassword,
      ]
    );

    if (userResult.rowCount === 0) {
      console.warn("Record exists, skipping");
      const existing = await pool.query(
        `
          SELECT user_id
          FROM users
          WHERE email = $1 OR emp_code = $2
          LIMIT 1
        `,
        [email.toLowerCase(), emp_code || null]
      );
      return res
        .status(200)
        .json({ id: existing.rows[0]?.user_id, message: "Record exists, skipping" });
    }

    const userId = userResult.rows[0].user_id;

    if (Array.isArray(roles) && roles.length > 0) {
      await syncUserRoles(userId, roles, req.user?.user_id);
    }

    const normalizedPermissions = await normalizePermissionAssignments(
      permissions || []
    );
    if (normalizedPermissions.length > 0) {
      await syncUserPermissions(userId, normalizedPermissions, req.user?.user_id);
    }

    invalidatePermissionCache();
    res.status(201).json({ id: userId });
  } catch (error) {
    if (error.code === "23505") {
      console.warn("Record exists, skipping");
      return res.status(200).json({ message: "Record exists, skipping" });
    }
    console.error("Failed to create user:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
});

router.put("/users/:userId", authenticate, assertAdminOrPermission, async (req, res) => {
  const { userId } = req.params;
  const {
    name,
    emp_code,
    email,
    phone,
    department,
    password,
    roles,
    permissions,
  } = req.body || {};

  try {
    await withTransaction(async (client) => {
      if (password) {
        const hashed = await bcrypt.hash(password, 10);
        await client.query(
          `
            UPDATE users
            SET password_hash = $2
            WHERE user_id = $1
          `,
          [userId, hashed]
        );
      }

      await client.query(
        `
          UPDATE users
          SET name = COALESCE($2, name),
              emp_code = COALESCE($3, emp_code),
              email = COALESCE($4, email),
              phone = COALESCE($5, phone),
              department = COALESCE($6, department),
              role = CASE
                        WHEN $7::text IS NOT NULL THEN $7
                        ELSE role
                     END
          WHERE user_id = $1
        `,
        [
          userId,
          name || null,
          emp_code || null,
          email ? email.toLowerCase() : null,
          phone || null,
          department || null,
          Array.isArray(roles) && roles.length > 0 ? "custom" : null,
        ]
      );

      if (Array.isArray(roles)) {
        await syncUserRoles(userId, roles, req.user?.user_id);
      }

      if (Array.isArray(permissions)) {
        const normalizedPermissions = await normalizePermissionAssignments(
          permissions
        );
        await syncUserPermissions(userId, normalizedPermissions, req.user?.user_id);
      }
    });

    invalidatePermissionCache();
    res.json({ id: Number(userId) });
  } catch (error) {
    console.error("Failed to update user:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

module.exports = router;
