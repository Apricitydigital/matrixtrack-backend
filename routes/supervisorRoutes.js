const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authenticate"); // Ensure users are logged in

// ✅ Fetch all supervisors (Only Admins can fetch)
router.get("/", async (req, res) => {
  try {
    const supervisors = await pool.query(
      "SELECT user_id, name, emp_code, email, phone, role FROM users WHERE role = 'supervisor'"
    );
    res.json(supervisors.rows);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Update Supervisor (Name, Phone, Email Only)
router.put("/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { name, emp_code, email, phone, role, password, passChange } = req.body;

  try {
    if (passChange) {
      await pool.query(
        "UPDATE users SET name=$1, emp_code=$2, email=$3, phone=$4, role=$5, password=crypt($6, gen_salt('bf')) WHERE user_id=$7",
        [name, emp_code, email, phone, role, password, id]
      );
    } else {
      await pool.query(
        "UPDATE users SET name=$1, emp_code=$2, email=$3, phone=$4, role=$5 WHERE user_id=$6",
        [name, emp_code, email, phone, role, id]
      );
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Supervisor not found" });
    }
    res.json({
      message: "Supervisor updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Update failed" });
  }
});

// ✅ Delete Supervisor
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM users WHERE user_id = $1", [id]);
    res.json({ message: "Supervisor deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});
module.exports = router;
