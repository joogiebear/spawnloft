# Signing the Mac beta

The public Windows release and its Azure signing configuration are unchanged. Mac beta
signing uses Apple Developer ID and notarization on the existing GitHub macOS runners.
The Mac app remains distributed directly as DMG/ZIP; this does not submit it to the Mac App Store.

## 1. Create the certificate on your Mac

With the Apple Developer membership active, sign in to Xcode under **Settings → Accounts**.
Select the Apple account/team, choose **Manage Certificates**, then **+ → Developer ID Application**.
Use the Account Holder account. A development certificate or Developer ID Installer certificate
is not the certificate for this app.

Export the Developer ID Application signing identity as a password-protected `.p12` file.
The export must contain both the certificate and its private key. In Xcode's certificates
sheet, Control-click the certificate and choose **Export Certificate**. Alternatively use
Keychain Access → My Certificates and export the certificate with its matching private key.
Keep an encrypted backup of the identity and keep the password separate.

Apple's instructions:
- [Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [Export signing identities](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates)

## 2. Set the GitHub Actions secrets

Use the [SpawnLoft repository secrets](https://github.com/joogiebear/spawnloft/settings/secrets/actions).
Do not paste secrets into an issue, PR, conversation, source file, or workflow YAML.

| Repository secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 encoding of the exported `.p12`, including its private key |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | The Apple Account email used for notarization |
| `APPLE_TEAM_ID` | The 10-character Team ID from Apple Developer → Membership details |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password created for this release pipeline |

Create the app-specific password at [account.apple.com](https://account.apple.com) under
**Sign-In and Security → App-Specific Passwords**. Label it for SpawnLoft notarization.
This is not your normal Apple Account password.

On the Mac, with GitHub CLI authenticated to the repository, upload the certificate without
printing its contents. Substitute its actual local path:

```sh
base64 -i /path/to/SpawnLoft-Developer-ID.p12 | gh secret set MAC_CSC_LINK --repo joogiebear/spawnloft
gh secret set MAC_CSC_KEY_PASSWORD --repo joogiebear/spawnloft
gh secret set APPLE_ID --repo joogiebear/spawnloft
gh secret set APPLE_TEAM_ID --repo joogiebear/spawnloft
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo joogiebear/spawnloft
```

The last four commands prompt for their values. Do not put passwords in command arguments.
Apple's [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
describes this authentication method. API-key authentication can be added separately if needed.

## 3. Enable signed development builds

After the signing changes are reviewed/merged into `dev` and all five secrets are present,
set the repository Actions **variable** `MAC_SIGNING_ENABLED` to `true`. Dispatch
`desktop-preview` on `dev` to build a new numbered beta. Never replace a published release.

The workflow resolves the signing policy once per run. Only `dev` pushes and manual `dev`
runs can use signed mode. Pull requests and other branches remain ad-hoc and receive no
Apple signing credentials. Missing credentials or failed notarization fail the signed build;
they do not fall back to an unsigned release.

The app and helpers use hardened runtime with the V8 JIT entitlement. The workflow verifies
the signature, expected Team ID, secure timestamp, hardened runtime, stapled notarization
ticket, and Gatekeeper acceptance before the packaged app smoke tests. Both Mac architectures
must report the same signing mode before publishing. Release notes use the verified mode.

Signed releases publish combined `beta-mac.yml` and `latest-mac.yml` feeds only after
both native ZIPs pass verification. Ad-hoc builds do not publish Mac feeds. The
existing Windows updater and stable release channel are preserved. Beta.25 and older
need one manual replacement to enable automatic updates.

## 4. Test the downloaded release

Download the appropriate DMG from the new beta release using a browser on a Mac, replace
the previous app, and launch normally. Test the GUI, bundled CLI, server startup, console,
backups/restore, and managed MySQL. Apple Silicon and Intel still need their own native checks.
This first signed run is needed to validate the real credentials and entitlements; local
unit tests cannot prove notarization or Gatekeeper behavior.
