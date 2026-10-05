import { createApp } from './app.js';
const port = process.env.PORT || 4000;
createApp().then((app) => app.listen(port, () => console.log(`ApparelFlow listening on :${port}`)))
  .catch((e) => { console.error(e); process.exit(1); });
