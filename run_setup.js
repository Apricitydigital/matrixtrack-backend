const { ensureRbacSchema } = require('./utils/rbacSetup');

async function run() {
  try {
    console.log('Running RBAC schema setup...');
    await ensureRbacSchema();
    console.log('Schema setup complete!');
  } catch (err) {
    console.error('Setup failed:', err);
  } finally {
    process.exit();
  }
}

run();
