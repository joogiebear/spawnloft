# Mac Signing and Notarization

Public Windows releases and their Azure signing configuration are unchanged. Mac builds are signed with an Apple Developer ID certificate and notarized on the existing GitHub macOS runners, and distributed directly as DMG and ZIP. This does not submit the app to the Mac App Store.

| Fact | Detail |
| --- | --- |
| Signing identity | Developer ID Application (not a development certificate, not Developer ID Installer) |
| Runtime hardening | Hardened runtime with the V8 JIT entitlement (`desktop/build/entitlements.spawnloft.plist`) on the app and its helpers |
| Notarization | Apple notary service, ticket stapled to the app |
| Signing policy | Resolved once per workflow run by `desktop/mac-signing.cjs` |
| Signed mode | Only `dev` pushes and manual `dev` runs. Pull requests and other branches stay ad-hoc and receive no Apple credentials. |
| Failure behavior | Missing credentials or failed notarization fail the signed build. They never fall back to an unsigned release. |

## 1. Create the certificate

With an active Apple Developer membership, on your Mac:

1. Sign in to Xcode under **Settings → Accounts** with the Account Holder account.
2. Select the team and choose **Manage Certificates**.
3. Click **+** and choose **Developer ID Application**.
4. Export the identity as a password-protected `.p12`: Control-click the certificate in the sheet and choose **Export Certificate**, or use **Keychain Access → My Certificates** and export it with its matching private key. The export must contain both the certificate and the private key.

Keep an encrypted backup of the identity and store its password separately.

Apple references: [Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates), [Export signing identities](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates).

## 2. Set the GitHub Actions secrets

Set these under the [repository secrets](https://github.com/joogiebear/spawnloft/settings/secrets/actions). Never paste secrets into an issue, pull request, conversation, source file or workflow YAML.

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 encoding of the exported `.p12`, private key included |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | Apple Account email used for notarization |
| `APPLE_TEAM_ID` | 10-character Team ID from **Apple Developer → Membership details** |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password created for this pipeline |

Create the app-specific password at [account.apple.com](https://account.apple.com) under **Sign-In and Security → App-Specific Passwords**, labelled for SpawnLoft notarization. It is not your Apple Account password.

With GitHub CLI authenticated to the repository, upload without printing contents, substituting the real path:

```sh
base64 -i /path/to/SpawnLoft-Developer-ID.p12 | gh secret set MAC_CSC_LINK --repo joogiebear/spawnloft
gh secret set MAC_CSC_KEY_PASSWORD --repo joogiebear/spawnloft
gh secret set APPLE_ID --repo joogiebear/spawnloft
gh secret set APPLE_TEAM_ID --repo joogiebear/spawnloft
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo joogiebear/spawnloft
```

The last four commands prompt for their values. Do not pass passwords as command arguments. This uses Apple's [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) with Apple ID authentication; API-key authentication can be added separately.

## 3. Enable signed builds

After the signing changes are merged into `dev` and all five secrets exist, set the repository Actions **variable** `MAC_SIGNING_ENABLED` to `true`, then dispatch `desktop-preview` on `dev` to build a new numbered beta. Never replace a published release.

The workflow verifies, before the packaged-app smoke tests:

| Check | Detail |
| --- | --- |
| Signature | Valid, with the expected Team ID |
| Timestamp | Secure timestamp present |
| Runtime | Hardened runtime enabled |
| Notarization | Ticket stapled |
| Gatekeeper | Accepts the app |
| Consistency | Both architectures report the same signing mode; release notes use the verified mode |

| Update feed | Published when |
| --- | --- |
| `beta-mac.yml`, `latest-mac.yml` | Only after both native ZIPs pass verification |
| None for ad-hoc builds | Ad-hoc builds publish no Mac feeds |

The Windows updater and stable channel are preserved. Betas numbered 25 and earlier need one manual replacement to enable automatic updates.

## 4. Test the downloaded release

In a browser on a Mac, download the matching DMG from the new beta release, replace the previous app, and launch normally. Test the GUI, the bundled CLI, server startup, console, backup and restore, and managed MySQL. Apple Silicon and Intel each need their own native check. The first signed run validates the real credentials and entitlements; unit tests cannot prove notarization or Gatekeeper behavior.
