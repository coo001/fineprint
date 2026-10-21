// Vercel Node.js adapter. The HTTP server's existing request handler is reused.
import { createServer } from '../server.js';
const app = createServer();
export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = typeof req.query?.route === 'string' ? req.query.route : url.searchParams.get('route');
  if (route && /^[a-z-]+$/.test(route)) req.url = '/api/' + route;
  app.emit('request', req, res);
}
