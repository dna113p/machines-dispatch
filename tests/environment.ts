// Preloaded by `npm test`. Hosted runs publish run status unless
// MACHINES_RUN_STATUS_DIR is "off" (unset means on, in the user's state
// directory), so a developer's own directory must not receive the suite's runs.
process.env.MACHINES_RUN_STATUS_DIR = "off";
delete process.env.MACHINES_RUN_OWNER;
delete process.env.MACHINES_RUN_PARENT;
delete process.env.MACHINES_RUN_LABEL;
