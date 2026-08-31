import dotenv from 'dotenv'
dotenv.config({ path: ['.env.local', '.env'] })
import { runLongbridgeCli } from './api/longbridge/longbridgeCli.ts'
async function run() {
  console.log(await runLongbridgeCli(['check', '--format', 'json']))
}
run()
