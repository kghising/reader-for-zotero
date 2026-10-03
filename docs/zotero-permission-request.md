# Note to the Zotero team (draft)

Send to Zotero's contact address (see <https://www.zotero.org/support/terms/trademark> and <https://www.zotero.org/support/dev/>). You could also post it on the Zotero developer forum or zotero-dev list.

---

**Subject:** Permission to name and run a read-only Claude connector for the Zotero Web API

Hello,

I'm building **Reader for Zotero**, an open-source, read-only MCP server that lets people connect their own Zotero library to Claude (Anthropic's assistant). The code is at https://github.com/kghising/reader-for-zotero.

How it works:

- Each user authorizes through Zotero's OAuth flow and approves a **read-only** key (`write_access=0`). There is no shared key.
- It uses Web API v3 only, with no scraping. It honours `Backoff` and `Retry-After`, keeps to 4 or fewer concurrent requests, and paginates.
- It stores only each user's encrypted API key and user ID. No library content is cached or stored.
- Every page says it is not affiliated with or endorsed by Zotero or the Corporation for Digital Scholarship, and it doesn't use the Zotero logo.

I'd like to list it in Anthropic's public connectors directory. The directory asks whether a third-party API is used with the provider's permission, so I have two questions:

1. Are you comfortable with the name "Reader for Zotero"? If not, I'm happy to use a name you prefer.
2. Is this use of the Web API OK with you, including listing it in Anthropic's directory? Do you have any guidance on rate limits or user-agent identification?

I'm happy to share anything else, including the privacy policy and test results. Thank you for Zotero!

Best regards,
[YOUR NAME]
[CONTACT EMAIL]
