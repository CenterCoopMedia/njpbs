// Preload before tsx or the build entry can receive a service-group stop.
// The systemd stop timeout and final group kill still bound the active build.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
