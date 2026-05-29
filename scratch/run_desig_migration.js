const { runMigrations } = require("../db/migrations");
runMigrations().then(() => {
    console.log("Migrations executed successfully");
    process.exit(0);
}).catch(err => {
    console.error("Migrations failed", err);
    process.exit(1);
});
