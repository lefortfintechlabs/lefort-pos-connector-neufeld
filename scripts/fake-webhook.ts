import { startFakeWebhook } from './lib/fakeWebhook';

const port = Number(process.env.PORT ?? 8787);
const token = process.env.LEFORT_WEBHOOK_TOKEN;

startFakeWebhook({ port, token }).then(() => {
  console.log(`Webhook de pruebas en http://localhost:${port}/events ${token ? '(exige token Bearer)' : '(sin token)'}`);
  console.log(`Cambiar modo:  curl -X POST 'http://localhost:${port}/__mode?mode=down'   (ok|down|flaky|partial|noack|unauthorized)`);
  console.log(`Estadísticas:  curl http://localhost:${port}/__stats`);
});
