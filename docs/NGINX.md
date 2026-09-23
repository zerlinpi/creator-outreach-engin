# Nginx reverse proxy

For a same-host Nginx deployment, bind the Node process to loopback:

```env
CONNECTOR_BIND_HOST=127.0.0.1
CONNECTOR_ALLOWED_HOSTS=domail.example.com,127.0.0.1
```

Proxy the complete application surface instead of routing only `/mcp`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}
```

Deny deployment files before any static-file rule:

```nginx
location ~ ^/(?:\.env(?:\.|$)|\.git(?:/|$)|package(?:-lock)?\.json$|data(?:/|$)|src(?:/|$)|tests(?:/|$)|scripts(?:/|$)|tsconfig(?:\.[^/]+)?\.json$|Dockerfile$) {
    deny all;
    return 404;
}
```

The public routes that must still reach Node include `/admin`, `/admin/app.js`, `/admin/api/*`, `/mcp`, `/health`, `/ready`, `/.well-known/*`, and `/oauth/*`.

After reloading Nginx and restarting the Node service, run:

```bash
npm run probe
```

A successful probe confirms the main HTTP/OAuth/MCP routes and fails if common deployment files become publicly readable.
