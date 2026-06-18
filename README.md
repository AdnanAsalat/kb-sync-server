# hCaptcha Trainer Pro — KB Sync Server

Chhota, lightweight server jo training data (KB) ko 2 PCs ke beech sync karta hai.

## Endpoints
- `GET /`        → health check (browser me khol kar test karo)
- `GET /kb`      → KB pull (header `X-Sync-Secret` chahiye)
- `POST /kb`     → KB push (header `X-Sync-Secret` chahiye)

## Railway Environment Variables (zaroori)
- `SYNC_SECRET`  → ek secret password (dono PCs me bhi yahi daalna hoga)
- `DATA_DIR`     → `/data`  (Railway Volume ka mount path)

## Railway Volume
Ek volume banao aur `/data` pe mount karo — taake redeploy pe KB safe rahe.
