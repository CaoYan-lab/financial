# ChangFu on Volcengine

This directory deploys ChangFu as three isolated veFaaS web functions:

- `changfu-gateway` (`1j89q2s3`): public only through APIG.
- `changfu-decision-worker` (`llh7dd7h`): called by Gateway through the
  APIG private origin.
- `changfu-admin`: serves the internal Admin Web and `/api/v1/admin/*` API
  through a dedicated APIG service.

Both functions use the existing Beijing `fin-vpc` and the private `financial`
PostgreSQL database. They must not reuse the `fin-web` or `fin-worker` function
IDs.

## Release order

1. Connect to `root@115.191.35.144` and run `scripts/inventory.sh` on
   `ECS-0EJj-deploy`.
2. Create the `changfu_runtime` and `changfu_admin_runtime` PostgreSQL login
   roles without schema ownership. The Admin role has only identity,
   subscription, slot, audit, and official-model permissions. The AIDAP account
   named `changfu_app` is not used because AIDAP assigns it the privileged
   `neon_superuser` role.
3. Create all three veFaaS functions from the gateway, worker, and admin image
   targets in `Dockerfile.vefaas`. Configure port `8000`, VPC access, TLS logs,
   and the environment variables in `env/.env.cloud.example`.
   `changfu-admin` must use `CHANGFU_ADMIN_DATABASE_URL`, not the Gateway or
   migration credential. Inject `CHANGFU_ADMIN_INITIAL_PASSWORD` only through a
   secret; it seeds `admin` once and never overwrites an existing account.
4. Run `scripts/configure-apig.sh` with its default dry-run behavior. Review the
   generated JSON, then explicitly set `CHANGFU_APIG_APPLY=YES`.
5. Build and push immutable images with `scripts/build-and-push-image.sh vNN`.
   For an exported source snapshot without `.git`, set `CHANGFU_SOURCE_SHA` to
   the verified snapshot digest.
6. Set `CHANGFU_CONFIRM_RELEASE=YES` and run
   `scripts/release-from-deploy-host.sh vNN-gitsha`.

The release script starts an ephemeral VPC-attached migrator function, runs
migrations with the migration account, reapplies least-privilege grants, verifies
the database separately as `changfu_runtime` and `changfu_admin_runtime`, and
removes the migrator. It then publishes Worker, Gateway, and Admin and finishes
with Worker, public API, and Admin readiness checks.

## Production resources

The initial production deployment completed on 2026-09-28:

| Resource | ID / origin |
|---|---|
| Image tag | `v1-247bf2376000-{gateway,worker,migrator}` |
| Gateway function | `1j89q2s3` |
| Worker function | `llh7dd7h` |
| Admin function | Not created; populate `CHANGFU_ADMIN_FUNCTION_ID` before release |
| Public APIG service | `s1t8is7jgm85sfs523g5l` |
| Public API origin | `https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com` |
| Worker APIG service | `sp33su7erhd197sn87lsu` |
| Private Worker origin | `https://sp33su7erhd197sn87lsu.apigateway-cn-beijing-inner.volceapi.com` |
| Admin APIG service | Not created; `configure-apig.sh` is dry-run by default |

The current APIG API exposes both default public and private domains for a
service. Gateway uses only the private Worker origin. Internal POST routes still
require `CHANGFU_INTERNAL_TOKEN`; an unauthenticated public probe returns 401.
The desktop app uses the APIG default HTTPS origin directly; no custom domain or
certificate is required.

## Function settings

| Setting | Gateway | Worker | Admin |
|---|---:|---:|---:|
| CPU / memory | 1 vCPU / 2 GiB | 2 vCPU / 4 GiB | 1 vCPU / 2 GiB |
| Min / max instances | 1 / 4 | 1 / 4 | 1 / 2 |
| Concurrency | 20 | 10 | 20 |
| Request timeout | 360 s | 330 s | 60 s |
| APIG route timeout | Disabled | Disabled | Disabled |
| PostgreSQL pool | 5 | 3 | 5 |

APIG must not add a second request deadline. The veFaaS function and application
timeouts are authoritative; an enabled APIG timeout has caused premature 504
responses and `client canceled request` entries while the function was healthy.

Do not enable request-body, Cookie, CSRF, API Key, or Authorization logging.
Admin must be exposed through its own HTTPS APIG service and must not share the
desktop bearer-token routes. Keep previous revisions available so rollback only
changes the three ChangFu revision pointers.

## Verified shared resources

Read-only inventory on 2026-09-28 confirmed:

- VPC: `fin-vpc` (`vpc-3nqey47tkx0xs931ecfjzkvv`)
- Subnets: `fin-subnet-a` and `fin-subnet-b`
- Security group: `fin-sg-faas` (`sg-3ptanrsgtpg5c6csxywk5m8jp`)
- APIG: `fin-apig` (`gdad3vjhdofpi9evvmnqg`), public and private networking enabled
- CR: `docker-cr-input/fin`
- Database: AIDAP PostgreSQL database `financial`, SSL required

The standard RDS PostgreSQL instance named `Agentkit-PG` is unrelated and must
not be selected for ChangFu.
