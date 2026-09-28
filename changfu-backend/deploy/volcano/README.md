# ChangFu on Volcengine

This directory deploys ChangFu as two isolated veFaaS web functions:

- `changfu-gateway` (`1j89q2s3`): public only through APIG.
- `changfu-decision-worker` (`llh7dd7h`): called by Gateway through the
  APIG private origin.

Both functions use the existing Beijing `fin-vpc` and the private `financial`
PostgreSQL database. They must not reuse the `fin-web` or `fin-worker` function
IDs.

## Release order

1. Connect to `root@115.191.35.144` and run `scripts/inventory.sh` on
   `ECS-0EJj-deploy`.
2. Create the `changfu_runtime` PostgreSQL login role without schema
   ownership. The AIDAP account named `changfu_app` is not used because AIDAP
   assigns it the privileged `neon_superuser` role.
3. Create both veFaaS functions from the two image targets in
   `Dockerfile.vefaas`. Configure port `8000`, VPC access, TLS logs, and the
   environment variables in `env/.env.cloud.example`.
4. Run `scripts/configure-apig.sh` with its default dry-run behavior. Review the
   generated JSON, then explicitly set `CHANGFU_APIG_APPLY=YES`.
5. Build and push immutable images with `scripts/build-and-push-image.sh vNN`.
   For an exported source snapshot without `.git`, set `CHANGFU_SOURCE_SHA` to
   the verified snapshot digest.
6. Set `CHANGFU_CONFIRM_RELEASE=YES` and run
   `scripts/release-from-deploy-host.sh vNN-gitsha`.

The release script starts an ephemeral VPC-attached migrator function, runs
migrations with the migration account, reapplies least-privilege grants, verifies
the database as `changfu_runtime`, and removes the migrator. It then publishes
Worker before Gateway and finishes with Worker and public readiness checks.

## Production resources

The initial production deployment completed on 2026-09-28:

| Resource | ID / origin |
|---|---|
| Image tag | `v1-247bf2376000-{gateway,worker,migrator}` |
| Gateway function | `1j89q2s3` |
| Worker function | `llh7dd7h` |
| Public APIG service | `s1t8is7jgm85sfs523g5l` |
| Public API origin | `https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com` |
| Worker APIG service | `sp33su7erhd197sn87lsu` |
| Private Worker origin | `https://sp33su7erhd197sn87lsu.apigateway-cn-beijing-inner.volceapi.com` |

The current APIG API exposes both default public and private domains for a
service. Gateway uses only the private Worker origin. Internal POST routes still
require `CHANGFU_INTERNAL_TOKEN`; an unauthenticated public probe returns 401.
The desktop app uses the APIG default HTTPS origin directly; no custom domain or
certificate is required.

## Function settings

| Setting | Gateway | Worker |
|---|---:|---:|
| CPU / memory | 1 vCPU / 2 GiB | 2 vCPU / 4 GiB |
| Min / max instances | 1 / 4 | 1 / 4 |
| Concurrency | 20 | 10 |
| Request timeout | 360 s | 330 s |
| PostgreSQL pool | 5 | 3 |

Do not enable request-body or Authorization logging. Keep the previous
revisions available so rollback only changes the two ChangFu revision pointers.

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
