# Providers guard each other: LND's own tower (LIJOX duty W3)

A provider's channels — every one, public and private — are backed up to another provider's tower, so that an old
channel state published while your node is down is still answered. This is settings only: LND carries a tower and a
tower client. Done on LiJ-Node 1 and LiJ-Node 2 on 2026-11-13; the steps below are those, as run.

What it covers, read in LND's source at the version the patched node is built from (0.21.8): the tower client
registers every channel when its link starts; anchor channels use the anchor kind of data, all others the plain
kind. What it does not cover: payments that were in flight in the old state.

You need one other LIJOX provider to pair with. Each of you runs a tower and points your tower client at the
other's.

## 1. See what you have (changes nothing)

```
lncli tower info
```

```
lncli wtclient towers
```

"watchtower not active" / "watchtower client not active" means the setting is off. A tower's `uris` line is what
you give to your pair.

## 2. Turn the tower and the client on (a plain node)

Make a dated copy of the settings file first (it does not overwrite an existing copy):

```
cp -n ~/.lnd/lnd.conf ~/.lnd/lnd.conf.bak-$(date +%Y%m%d)
```

Add the two sections at the end of the file:

```
printf '\n[watchtower]\nwatchtower.active=true\n\n[wtclient]\nwtclient.active=true\n' >> ~/.lnd/lnd.conf
```

See the difference — exactly six added lines:

```
diff ~/.lnd/lnd.conf.bak-$(date +%Y%m%d) ~/.lnd/lnd.conf
```

Restart LND at a quiet hour (your wallets' connections drop for a few seconds; the adapter's streams to LND come
back by themselves within seconds):

```
sudo systemctl restart lnd
```

```
lncli tower info
```

The tower listens on port 9911 on every interface. If your node has Tor configured, the tower also makes its own
onion address, shown under `uris`. You do not need to open port 9911 to the internet: give your pair the onion
address.

On an Umbrel, the tower and the tower client are turned on in the Lightning app's own settings (seen active on
LiJ-Node 2; that screen is not described here). On StartOS: not yet written.

## 3. Add your pair's tower

Your pair sends you their `uris` line (`<pubkey>@<address>.onion:9911`). Then:

```
lncli wtclient add <pubkey>@<address>.onion:9911
```

```
lncli wtclient towers
```

On an Umbrel, put `docker exec lightning_lnd_1` in front of `lncli`.

Your pair does the same with your line.

## 4. See it working

A session with the tower is made when one of your channels next changes state. After a payment, or a day:

```
lncli wtclient stats
```

"sessions acquired" of 1 or more and "backups" above 0 mean your states are reaching the tower.

## The way back

```
cp ~/.lnd/lnd.conf.bak-<date> ~/.lnd/lnd.conf
```

```
sudo systemctl restart lnd
```

## What a tower learns

Nothing, until one of your old states is published: the data is encrypted under that state's transaction id. It
sees your node's tower-client key, your address, and how often your channels change state.
