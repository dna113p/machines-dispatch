// Preloaded by `npm test`. Hosted runs publish run status when
// MACHINES_RUN_STATUS_DIR is set, so a developer's own directory must not
// receive the suite's runs.
delete process.env.MACHINES_RUN_STATUS_DIR;
delete process.env.MACHINES_RUN_OWNER;
delete process.env.MACHINES_RUN_PARENT;
delete process.env.MACHINES_RUN_LABEL;
