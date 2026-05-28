# run-bench-10x.ps1
# Runs the zk-bench suite 10 times, 1 iteration each, as independent
# process invocations. Each run wipes the wallet level-db so it re-syncs
# from a clean state, and each run writes its own timestamped log to .\logs\.

$projectRoot = "C:\Users\jinta\Desktop\zk-bench"
$compose     = Join-Path $projectRoot "standalone.yml"
$levelDb     = Join-Path $projectRoot "midnight-level-db"
$runs        = 20

Set-Location $projectRoot

# Bring the stack up once (no-op if the containers are already running)
docker compose -f $compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "docker compose failed - is Docker Desktop running?" -ForegroundColor Red
    exit 1
}
Start-Sleep -Seconds 10

# Environment shared across all runs
$env:BENCH_ENV         = "standalone"
$env:BENCH_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001"
$env:BENCH_ITERATIONS  = "1"

$failures = 0
for ($i = 1; $i -le $runs; $i++) {
    Write-Host "`n===== BENCH RUN $i / $runs =====" -ForegroundColor Cyan

    # Fresh wallet state each run (guarded so a missing folder isn't an error)
    if (Test-Path $levelDb) {
        Remove-Item -Recurse -Force $levelDb
    }

    yarn bench
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Run $i FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
        $failures++
    }
}

Write-Host "`nDone: $($runs - $failures)/$runs runs succeeded." -ForegroundColor Green
Write-Host "Logs are in $projectRoot\logs\" -ForegroundColor Green