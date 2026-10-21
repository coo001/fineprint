// Vercel Node.js adapter. The HTTP server's existing request handler is reused.
import { createServer } from '../server.js';
const app = createServer();
export default function handler(req, res) {
  app.emit('request', req, res);
}
