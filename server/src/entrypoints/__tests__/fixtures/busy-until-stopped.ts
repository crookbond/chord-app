// A role whose event loop is busy when the stop arrives, as the worker's is
// during mail sync. It stops cleanly on SIGTERM if it is given the chance.
const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
};
process.on('SIGTERM', async () => {
  await new Promise((r) => setTimeout(r, 20));
  process.exit(0);
});
setInterval(() => busy(200), 10);
process.stdout.write('ready\n');
