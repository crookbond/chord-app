/**
 * Wrap the current MASTER_KEY under Cloud KMS and print the `MASTER_KEY_WRAPPED=` line (ADR 0210).
 *
 * Run ON THE VM, where the service account can reach KMS, with the app's environment loaded:
 *   cd /srv/chord && set -a && . ./.env && set +a && NODE_ENV=production \
 *     npm run wrap:master-key --workspace=server
 *
 * It reads MASTER_KEY inside this process and prints ONLY the ciphertext, after checking that the
 * ciphertext unwraps back to the same bytes. The ciphertext is safe to keep in `.env.prod`: it is
 * useless without the KMS key. The master key itself is never printed or written.
 */
import { masterKeyKmsName, wrapMasterKey } from '../db/crypto/master-key.js';
import { GcpKmsKeyProvider } from '../db/crypto/key-provider.js';

async function main() {
  const raw = process.env.MASTER_KEY ?? '';
  if (!raw) throw new Error('MASTER_KEY is not set in this environment (nothing to wrap)');
  const plain = Buffer.from(raw, 'base64');
  if (plain.length !== 32) throw new Error(`MASTER_KEY must decode to 32 bytes; got ${plain.length}`);
  const name = masterKeyKmsName();
  if (!name) throw new Error('set MASTER_KEY_KMS_KEY or GCP_KMS_KEY_NAME to the key that should wrap it');
  const wrapped = await wrapMasterKey(plain, new GcpKmsKeyProvider(name));
  console.log(`# wrapped under ${name}; keep MASTER_KEY_KMS_KEY the same forever (it is bound in)`);
  console.log(`MASTER_KEY_WRAPPED=${wrapped}`);
}

main().catch((err) => {
  console.error(`wrap-master-key failed: ${(err as Error).message}`);
  process.exit(1);
});
