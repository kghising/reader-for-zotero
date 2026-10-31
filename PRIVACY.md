# Privacy policy

**Reader for Zotero** · Effective date: October 31, 2026 · Operator: Kishor Ghising · Contact: kghisinga@gmail.com

Reader for Zotero is an independent, open-source connector that lets Claude read your Zotero library at your request. It is not affiliated with or endorsed by Zotero, the Corporation for Digital Scholarship, or Anthropic.

## Summary

- We store only what is needed to keep you connected: your Zotero user ID and username, and an encrypted, read-only Zotero API key.
- We do not store, cache, sell or analyse your library content (items, notes, annotations, full text) or your Claude conversations.
- You can disconnect at any time by revoking the key at [zotero.org/settings/keys](https://www.zotero.org/settings/keys).

## What we collect and why

- **Zotero account identifiers and API key.** When you connect, Zotero gives this service a read-only API key for your account, along with your Zotero user ID and username. We need these to read your library when Claude calls a tool. They are stored in encrypted form, and the encryption key can only be unlocked with the access or refresh token held by your Claude connection. We cannot read them without a request from your connection.
- **OAuth connection records.** To run the sign-in, we store records about the app connecting (for example Claude's client ID, name and redirect address), plus hashes of the access and refresh tokens and their expiry times. We never store tokens in readable form.
- **Short-lived sign-in state.** While you are signing in, we keep temporary, encrypted sign-in data for up to 10 minutes, along with secure cookies in your browser.
- **Error logs.** If something fails, we log the type of error and HTTP status codes. Per-request logs, request URLs and request contents are not retained.

## What we do not collect

- We do not store or cache any content from your library: metadata, abstracts, notes, annotations, attachments or full text. Each tool call fetches what it needs from the Zotero API and passes it straight to Claude.
- We do not receive your Zotero password. You sign in on zotero.org.
- We do not access your Claude conversations, memory or files. We only see the tool arguments Claude sends, such as a search query or item key, and only to answer that request.
- We do not use analytics, advertising or tracking cookies.

## How information flows and who processes it

- **Zotero (Corporation for Digital Scholarship).** Your library data is read from the Zotero Web API using your key. Zotero's own [privacy policy](https://www.zotero.org/support/privacy) applies to your Zotero account.
- **Anthropic (Claude).** Tool results are returned to the Claude app you connected, where they become part of your conversation. Anthropic's privacy policy governs that conversation.
- **Cloudflare.** This service runs on Cloudflare Workers, and its connection records are stored in Cloudflare Workers KV. Cloudflare processes this data as our hosting provider.

We do not sell or share your information with anyone else, except where required by law.

## Retention

- Access tokens expire after 1 hour.
- A connection, including your encrypted Zotero key, is deleted automatically after 90 days without use, or as soon as you connect again from the same app.
- Temporary sign-in data expires after 10 minutes.
- Error logs are kept for up to 7 days by our hosting provider.
- The Zotero API key stays valid at Zotero until you revoke it. We recommend revoking it at [zotero.org/settings/keys](https://www.zotero.org/settings/keys) when you stop using this connector. The key is labelled "Reader for Zotero (Claude)".

## Your choices and rights

- **Disconnect:** remove the connector in Claude and revoke the key at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). Revoking the key stops all access immediately.
- **Access or deletion:** email us and we will delete any connection records linked to your Zotero user ID. Depending on where you live (for example under the GDPR or CCPA), you may have further rights to access, correct, delete or object to processing of your data. Contact us to exercise them.

## Security

All traffic uses HTTPS. Tokens are stored only as hashes, and Zotero keys are encrypted at rest. The connector asks Zotero for read-only permissions, so it cannot change your library. The source code is public at [github.com/kghising/reader-for-zotero](https://github.com/kghising/reader-for-zotero).

## Children

This service is not directed at children under 13 (or the minimum age in your country), and we do not knowingly collect their data.

## Changes

We will post changes here and update the effective date. For significant changes, we will also note them in the project README.

## Contact

Kishor Ghising · kghisinga@gmail.com · Issues: [github.com/kghising/reader-for-zotero/issues](https://github.com/kghising/reader-for-zotero/issues)
