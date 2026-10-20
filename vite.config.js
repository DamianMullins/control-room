import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';

// SvelteKit 3: all config (including the adapter) lives here, not in svelte.config.js.
// Vite reads .env for import.meta.env but does not put it in process.env, and server
// code here uses process.env — so load it explicitly. In production (adapter-node) the
// real environment comes from the platform.
export default ({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

  return {
    plugins: [sveltekit({ adapter: adapter() })],
    server: { port: 5390 },
  };
};
