const app = require('./app');
require('./seed')();
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`DelFood API berjalan di http://localhost:${port}`));
