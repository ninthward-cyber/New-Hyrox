// Netlify Function (v2). Routed from /api/food-photo/status and /api/food-photo/analyze by the redirects in netlify.toml
// (rewrite to /.netlify/functions/food-photo). No config.path: a function with config.path is NOT reachable at the
// /.netlify/functions/ path that those redirects target.
// Runtime: Node 22+. Only dependency: @netlify/blobs. The OpenAI call uses the platform fetch.
import { getStore } from '@netlify/blobs';
import { createHandler } from '../lib/handler.mjs';
import { blobStore } from '../lib/store.mjs';

const handle = createHandler({
  env: process.env,
  fetch: (...a) => fetch(...a),
  getStore: () => blobStore(getStore),
});

export default async (req, context) => handle(req, context);
