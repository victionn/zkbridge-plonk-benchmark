
# to run

docker compose -f C:\Users\jinta\Desktop\zk-bench\standalone.yml up -d
Start-Sleep -Seconds 10
$env:BENCH_ENV = "standalone"
$env:BENCH_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001"
$env:BENCH_ITERATIONS = "1"

Remove-Item -Recurse -Force C:\Users\jinta\Desktop\zk-bench\midnight-level-db
yarn bench