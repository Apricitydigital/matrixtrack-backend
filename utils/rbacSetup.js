const pool = require("../config/db");

const BASE_PERMISSIONS = [
  {
    module: "users",
    action: "view",
    label: "View Users",
    description: "Read-only access to users",
  },
  {
    module: "users",
    action: "create",
    label: "Create Users",
    description: "Create new user accounts",
  },
  {
    module: "users",
    action: "edit",
    label: "Edit Users",
    description: "Modify existing user accounts",
  },
  {
    module: "users",
    action: "delete",
    label: "Delete Users",
    description: "Remove user accounts",
  },
  {
    module: "roles",
    action: "view",
    label: "View Roles",
    description: "Read-only access to roles",
  },
  {
    module: "roles",
    action: "create",
    label: "Create Roles",
    description: "Create new roles",
  },
  {
    module: "roles",
    action: "edit",
    label: "Edit Roles",
    description: "Modify role definitions",
  },
  {
    module: "roles",
    action: "delete",
    label: "Delete Roles",
    description: "Remove custom roles",
  },
  {
    module: "permissions",
    action: "manage",
    label: "Manage Permissions",
    description: "Create/assign permissions",
  },
  {
    module: "permissions",
    action: "withhold",
    label: "Withhold Permissions",
    description: "Restrict sharing or delegation of permissions",
  },
  {
    module: "city",
    action: "view",
    label: "View Cities",
    description: "Access the list of cities",
  },
  {
    module: "city",
    action: "manage",
    label: "Manage Cities",
    description: "Create, update, or delete city records",
  },
  {
    module: "reports",
    action: "view",
    label: "View Reports",
    description: "Access analytics dashboards",
  },
  {
    module: "master",
    action: "view",
    label: "View Master Data",
    description: "Read master data lists",
  },
  {
    module: "master",
    action: "manage",
    label: "Manage Master Data",
    description: "Create and update master records",
  },
];

let schemaPromise = null;

const ensureBasePermissions = async (client) => {
  for (const permission of BASE_PERMISSIONS) {
    await client.query(
      `
        INSERT INTO permissions (module, action, label, description)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (module, action)
        DO UPDATE SET
          label = EXCLUDED.label,
          description = EXCLUDED.description,
          updated_at = NOW()
      `,
      [
        permission.module,
        permission.action,
        permission.label,
        permission.description,
      ]
    );
  }
};

const runSchemaSetup = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(80) UNIQUE NOT NULL,
        description TEXT,
        is_system BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id SERIAL PRIMARY KEY,
        module VARCHAR(120) NOT NULL,
        action VARCHAR(60) NOT NULL,
        label VARCHAR(160),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT permissions_unique UNIQUE (module, action)
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'roles_name_key'
        ) THEN
          ALTER TABLE roles
          ADD CONSTRAINT roles_name_key UNIQUE (name);
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'permissions_unique'
        ) THEN
          ALTER TABLE permissions
          ADD CONSTRAINT permissions_unique UNIQUE (module, action);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        granted_by INTEGER,
        PRIMARY KEY (role_id, permission_id)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_role_id_permission_id_key
      ON role_permissions (role_id, permission_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        assigned_at TIMESTAMPTZ DEFAULT NOW(),
        assigned_by INTEGER,
        PRIMARY KEY (user_id, role_id)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_id_role_id_key
      ON user_roles (user_id, role_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        granted_by INTEGER,
        PRIMARY KEY (user_id, permission_id)
      )
    `);

    await client.query(`
      ALTER TABLE user_permissions
      ADD COLUMN IF NOT EXISTS city_id INTEGER REFERENCES cities(city_id)
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS department VARCHAR(120)
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash TEXT
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'users_role_check'
            AND table_name = 'users'
        ) THEN
          ALTER TABLE users DROP CONSTRAINT users_role_check;
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (
        role IN (
          'admin',
          'supervisor',
          'user',
          'operator',
          'manager',
          'custom'
        )
      )
    `);

    await client.query(`
      INSERT INTO roles (name, description, is_system)
      VALUES
        ('admin', 'Full platform administrator', TRUE),
        ('supervisor', 'Supervisor default role', TRUE)
      ON CONFLICT (name) DO NOTHING
    `);

    await ensureBasePermissions(client);

    await client.query(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r
      CROSS JOIN permissions p
      WHERE r.name = 'admin'
      ON CONFLICT DO NOTHING
    `);

    await client.query("COMMIT");
    console.log("✅ RBAC schema verified/initialized");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("RBAC schema setup failed:", error);
    throw error;
  } finally {
    client.release();
  }
};

const ensureRbacSchema = () => {
  if (!schemaPromise) {
    schemaPromise = runSchemaSetup().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
};

module.exports = {
  ensureRbacSchema,
};
