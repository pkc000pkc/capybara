import 'dotenv/config'
import { buildApp } from '#app'

const app = await buildApp()
const port = Number.parseInt(process.env.PORT ?? '3005', 10)
try {
  await app.listen({ host: '0.0.0.0', port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
