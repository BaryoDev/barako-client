// The stack files, embedded as strings so they ship inside dist. `barako up` writes them to
// ~/.barako/stack. Compose reads values from the environment of the docker call (ports, image
// references) and from the .env file (secrets only).

export const SUBNET = "172.28.0.0/24";
export const CADDY_IP = "172.28.0.10";
export const API_HOST_PORT = 5005;
export const TENANT = "client";
export const ADMIN_USER = "admin";

export const COMPOSE_YML = `# Written by barako up. Edit nothing here; the next up rewrites it.
name: barako

services:
  postgres:
    image: \${POSTGRES_IMAGE}
    restart: unless-stopped
    environment:
      POSTGRES_DB: barako
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${DB_PASSWORD:?missing from .env}
      APP_DB_PASSWORD: \${APP_DB_PASSWORD:?missing from .env}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./app-role.sql:/docker-entrypoint-initdb.d/app-role.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres -d barako"]
      interval: 5s
      timeout: 5s
      retries: 12
    networks: [edge]

  api:
    image: \${CORE_IMAGE}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:${API_HOST_PORT}:8080"
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      Tenancy__Mode: Single
      ConnectionStrings__DefaultConnection: Host=postgres;Database=barako;Username=barako_app;Password=\${APP_DB_PASSWORD}
      JWT__Key: \${JWT_KEY:?missing from .env}
      JWT__Issuer: barako-local
      JWT__Audience: barako-local
      InitialAdmin__Username: ${ADMIN_USER}
      InitialAdmin__Password: \${ADMIN_PASSWORD:?missing from .env}
      # Caddy is the only proxy, at a fixed address, so the real client address reaches the rate limiter.
      ForwardedHeaders__Enabled: "true"
      ForwardedHeaders__KnownProxies__0: ${CADDY_IP}
      AllowedHosts: "api;api.localhost;admin.localhost;localhost;127.0.0.1"
      CORS__AllowedOrigins: "http://admin.localhost:\${PORT},http://client.localhost:\${PORT}"
      # Every port is published on 127.0.0.1 only, so the limits are raised for a local stack.
      RateLimiting__Global__PermitLimit: "6000"
      RateLimiting__Global__WindowSeconds: "60"
      RateLimiting__Global__QueueLimit: "100"
      Seed__DemoContent: "false"
      Swagger__Enabled: "false"
    networks: [edge]

  site:
    image: \${PRESS_IMAGE}
    restart: unless-stopped
    depends_on:
      - api
    read_only: true
    tmpfs:
      - /tmp
      - /app/.next/cache:uid=1001
    environment:
      CMS_URL: http://api:8080
      CMS_TENANT: ${TENANT}
      SITE_URL: "http://client.localhost:\${PORT}"
      PRESS_SECRET: \${PRESS_SECRET:?missing from .env}
      PRESS_CONSOLE_ORIGINS: "http://admin.localhost:\${PORT}"
    networks: [edge]

  console:
    image: \${BREW_IMAGE}
    restart: unless-stopped
    depends_on:
      - api
    read_only: true
    tmpfs:
      - /tmp/barako-app:size=128m
      - /tmp
    environment:
      # The browser calls the API on the console's own host, so the refresh cookie stays same-site.
      NEXT_PUBLIC_API_URL: "http://admin.localhost:\${PORT}"
      NEXT_PUBLIC_PRESS_URL: "http://client.localhost:\${PORT}"
    networks: [edge]

  caddy:
    image: \${CADDY_IMAGE}
    restart: unless-stopped
    depends_on:
      - api
      - site
      - console
    ports:
      - "127.0.0.1:\${PORT}:8080"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    networks:
      edge:
        ipv4_address: ${CADDY_IP}

networks:
  edge:
    ipam:
      config:
        - subnet: ${SUBNET}

volumes:
  pgdata:
`;

export const CADDYFILE = `# Written by barako up. Plain http on a local port; every host name ends in .localhost.
{
	auto_https off
	admin off
}

http://client.localhost:8080 {
	handle /files* {
		reverse_proxy api:8080 {
			header_up X-Tenant ${TENANT}
		}
	}
	handle {
		reverse_proxy site:3000
	}
}

http://admin.localhost:8080 {
	handle /api/* {
		reverse_proxy api:8080
	}
	handle {
		reverse_proxy console:3000
	}
}

http://api.localhost:8080 {
	reverse_proxy api:8080
}
`;

export const APP_ROLE_SQL = `-- Runs once, on the first start of a fresh volume, as the database owner. Core refuses to start
-- outside Development as a superuser or a role with BYPASSRLS, so the API connects as this role.
\\getenv pw APP_DB_PASSWORD
CREATE ROLE barako_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'pw';
ALTER SCHEMA public OWNER TO barako_app;
`;

/** Pinned images for this CLI release. Each entry is the tag plus the digest of that tag. */
export const VERSIONS_JSON = `{
  "core": {
    "image": "ghcr.io/baryodev/barako-cms",
    "tag": "5.9.0",
    "digest": "sha256:cc9321214fd39f056cf4066dab5763b9a5ab70d27f89da16293ed55a416100f5"
  },
  "press": {
    "image": "ghcr.io/baryodev/barako-press",
    "tag": "0.18.1",
    "digest": "sha256:bd40afe6ace3ffd21908a73914c0a0e58eaa3d18f05fc35e41222e2e86ad23cb"
  },
  "brew": {
    "image": "ghcr.io/baryodev/barako-brew",
    "tag": "1.13.0",
    "digest": "sha256:cfc61f3522e6b8a3c477e3851cc889f039c8f8f52e6e4e835f8c7101d8fe1e42"
  },
  "postgres": {
    "image": "pgvector/pgvector",
    "tag": "pg16",
    "digest": "sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a"
  },
  "caddy": {
    "image": "caddy",
    "tag": "2.10-alpine",
    "digest": "sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
  }
}
`;
