# Push notifications (Expo) — TestFlight setup

How device push notifications reach an iOS device. Design rationale:
[ADR 0054](../notes/0054-expo-push-notifications.md).

Push fires for new group messages, bot replies / `@`-mentions, and the daily
briefing — anything the server broadcasts as `SSE.message` — fanned out to every
registered device of a group's members (minus the sender). The in-app
**Settings → Notifications** toggle registers/unregisters this device.

## What's already in place

- `expo-notifications` config plugin in `mobile/app.json` (injects the iOS
  `aps-environment` entitlement at build time).
- EAS project id `b33f8c59-0dc6-48c7-9fce-b2b7872e0ee8`, bundle `app.chord.demo`,
  Apple Team ID `5YLAQB2ZQZ` (shared with native deep-links).
- Server publisher + `POST`/`DELETE /api/v1/me/push-token`, gated by
  `PUSH_ENABLED`.

## One-time setup before it works

### 1. APNs key — managed by EAS

```bash
cd mobile
eas credentials            # iOS → Push Notifications → let EAS generate/manage the APNs key (.p8)
```

EAS stores the Apple Push Key; nothing is checked into the repo. This is what
lets Expo's push service hand notifications to Apple.

### 2. Build + ship to TestFlight

```bash
cd mobile
eas build --profile production --platform ios
eas submit --profile production --platform ios   # prompts for Apple ID / ASC app id if not in eas.json
```

Push **only** works in a real build on a real device (TestFlight / production) —
never the iOS simulator, and never Expo Go on SDK 54.

### 3. Turn it on server-side

Set `PUSH_ENABLED=1` (and `EXPO_ACCESS_TOKEN` only if the Expo project enforces
enhanced push security) in the deployed server's `.env`. Off by default so
tests/CI/local dev never reach Expo.

## Verifying

- **No device:** with `PUSH_ENABLED=1`, register a dummy token via
  `POST /me/push-token`, post a message to a group, and watch the logs — Expo
  returns `DeviceNotRegistered` for the fake token and the publisher prunes it,
  exercising the whole path.
- **On device:** install the TestFlight build → Settings → toggle Notifications
  on (grant the iOS permission) → background the app → trigger a briefing or have
  another member post → the notification arrives, and tapping it opens the group.

## Notes

- In-process, per-node (like the SSE hub). A multi-node deploy would fan out per
  node; see [ADR 0002](../notes/0002-sse-over-websockets.md).
- Dead tokens are pruned automatically on the `DeviceNotRegistered` send ticket
  — no manual cleanup. Account deletion drops a user's tokens via
  `ON DELETE CASCADE`.
