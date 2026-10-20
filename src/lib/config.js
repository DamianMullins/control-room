// Env access that works in dev and in production (adapter-node).
//
// SvelteKit 3 replaced `$env/dynamic/private` with `$app/env/private`, which requires every
// variable to be declared through `defineEnvVars`. This app is configured entirely from
// ordinary environment variables, so it reads process.env directly; vite.config.js loads
// .env into process.env in dev, and the platform provides it at runtime in production.
export const env = (name) => process.env[name];
