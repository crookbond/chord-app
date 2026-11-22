// Loads the repo-root .env files into process.env before Expo's bundler
// reads them, so EXPO_PUBLIC_* vars defined in the shared /.env.local
// get inlined into the mobile bundle without us having to duplicate
// them in mobile/.env.local. Mirrors how server/src/config/env.ts
// anchors dotenv to the repo root.
//
// Precedence: .env.local wins, .env fills in anything missing — same
// rule the server uses. dotenv doesn't overwrite already-set vars by
// default, so loading .env.local first is correct.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Android push goes through Firebase Cloud Messaging, which needs the app's
// google-services.json at build time. It is read from the EAS file variable
// GOOGLE_SERVICES_JSON when set, else from mobile/google-services.json when
// that file exists. With neither, the Android build still works but cannot
// receive push notifications.
const fs = require('node:fs');
const localGoogleServices = path.resolve(__dirname, 'google-services.json');
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ||
  (fs.existsSync(localGoogleServices) ? './google-services.json' : undefined);

module.exports = ({ config }) =>
  googleServicesFile
    ? { ...config, android: { ...config.android, googleServicesFile } }
    : config;
