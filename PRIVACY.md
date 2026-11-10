# Privacy policy: The Eyes of Argus

_Last updated: 10 November 2026_

The Eyes of Argus is a browser extension that lets you mark YouTube channels, social media
accounts and websites as "uses AI" or "owned by private equity", and shows those marks as badges.

## What stays on your device
Everything, by default. Your marks, settings and any list you subscribe to are stored in the
browser's local extension storage. The extension has no analytics, no ads and no tracking, and it
does not read or store your browsing history. On the supported sites it only looks at links on the
page to decide where to draw a badge; nothing about the pages you visit is recorded or sent anywhere.

## What can leave your device, and only if you turn it on
**Shared list (optional).** If you enter the address of a shared list, the extension downloads that
file about twice a day. The site hosting the file sees an ordinary download request (including your
IP address), as with any web page.

**Community sync (optional, off by default).** If you turn it on and enter a sync server address:
- The extension creates a random anonymous ID. No name, email or account is involved.
- Your marks are sent to that server as votes: the channel, account or website, the flag (AI or
  PE), yes or no, and the public display name of the channel.
- The extension downloads the whole community list. The server does not learn which pages or
  videos you look at.
- The server sees your IP address while handling a request. The reference server does not store IP
  addresses; it stores salted hashes of the network for rate limiting and for limiting how many
  votes from one network count.
- The sync server is operated by whoever runs the address you entered. Their handling of the data
  is their responsibility.

## Deleting your data
- Local data: remove marks in the settings page ("Delete all marks") or uninstall the extension.
- Server data: when you turn community sync off, choose to delete your votes. The extension then
  asks the server to delete your anonymous ID and every vote it made.

## Sharing and selling
No data is sold or shared with third parties. Votes you choose to send become part of an
anonymous, aggregated community list that other users of the same sync server download.

## Contact
Questions or requests: open an issue at https://github.com/AL3X-7777/eyes-of-argus/issues
