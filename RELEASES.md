# Releases — integrity and verification

Every release is an annotated git tag. The release artifact is a
DETERMINISTIC tarball produced by git itself, so anyone can rebuild
it byte-for-byte from the tag and compare checksums independently:

    git archive --format=tar --prefix=lijox-adapter-<VER>/ v<VER> | gzip -n > lijox-adapter-<VER>.tar.gz
    sha256sum lijox-adapter-<VER>.tar.gz

A checksum cannot live inside the tree it hashes, so each release's
sha256 is recorded HERE, on main, in the commit immediately after
the tag — and repeated in the GitHub Release notes.

To verify a download:
1. Fetch the tag and rebuild the tarball with the exact command
   above — your sha256 must match the one listed below.
2. Or compare your downloaded tarball's sha256 directly against the
   table. Fetch this file over two channels (git clone and the
   GitHub web UI) if you want to defend against a single tampered
   path.

Signed tags: not yet — a signing key is an operator-held secret and
none is established. Until then, integrity rests on the checksum
table + deterministic rebuild. When a maintainer GPG key exists,
tags will be signed and this file will list the key fingerprint.

## Release table

| version | tag | tarball sha256 |
|---|---|---|
| 0.52.0 | v0.52.0 | f7664e5d87805dd9c942be66d8f2505e7cb88538eeb39cc79e01d5332c7b09bc |
| 0.53.0 | v0.53.0 | 29d5fe829523547df4b8a046f3f6d8093c6c51c8c3255ca8cec10f149876305f |
| 0.53.1 | v0.53.1 | ef2de0888fddd6532a1601c9468b7cda7fcdfbcf130fe30c9449bf9be619c28d |
| 0.54.0 | v0.54.0 | 6534754bee0408a61bcd21eb4e8b5529d6a3c82df0d9bfe85b2170cfdfd5d8b4 |
| 0.54.1 | v0.54.1 | e362511c490c43482df5dcfd00ad57c26d925df6eb39276aa6f53f69fdd937e0 |
| 0.54.2 | v0.54.2 | 465aa591231640550debdc537303f39a37074f0901215864d5bb8dbe279a2922 |
| 0.54.3 | v0.54.3 | 02b0cbb1b6d05e8105a09808d9fe26ad864980544d304b42f5109360b53cc7e2 |
| 0.54.4 | v0.54.4 | 85a363d3e4652049ba4d93565115f69b4d3453a713eebfed38d99012922852e8 |
| 0.54.5 | v0.54.5 | 23342f707667c357a8b5e868dfdd212d759861c054d41820d5e3139fbb2056c2 |
| 0.54.6 | v0.54.6 | 9c9ab61a138a7bf95ba56df25591535bb28175e11eda72a06346f30a93f17518 |
| 0.55.0 | v0.55.0 | 845a98260faf8b0118a782f20292e872dae5a8493e02cf46ad59bf61a54f9c65 |
| 0.55.1 | v0.55.1 | e07d7dbb88f099a492bf0cec6b1fa309ad1775915f830481906c019c99c7531d |
| 0.55.3 | v0.55.3 | 57b9420250fc7f550b3ae51c9a9535f1469dc93fbd6028232bfad10710efdd32 |
| 0.55.4 | v0.55.4 | f5bace8a3d413387ff20a61eb8e6a0571e1933c16991beb29fa586b894a45dba |
| 0.55.5 | v0.55.5 | fc37e9d1242029c8e9e39f3591f57054de690ecd285eae2746e75e5ce9592714 |
| 0.55.6 | v0.55.6 | 77cc4005cca1a6243f68ac2fc0c247e7394134348ab057be76f3b4be791328d1 |
| 0.56.0 | v0.56.0 | 99c7d1bd3ad7dab9f32c8da4818121ca5066fb7cd3e7fd65b8d08e2992a1e3b7 |
| 0.56.1 | v0.56.1 | 23a57829fec089ac37c0e7a36e12696c76d8fa6b129d50bcca70f2c6addfcc26 |
| 0.56.2 | v0.56.2 | 9e102480a23db18d3014ea056ef008d3c949c22658bcde0979a3457723828c10 |
| 0.56.3 | v0.56.3 | de8e289046d0785900932130806f121b352941a7c933f53e111b682b7c54030f |
| 0.56.4 | v0.56.4 | 0f4c9ca2a59c0989d7d29cc32b40b3257971a7b488b6c7d235820313c24c9b52 |
| 0.57.0 | v0.57.0 | 0b4ef4bd5ed33734a3159ae0820050cbefa0fa07388012b01d4a28a948ab7b98 |
| 0.58.0 | v0.58.0 | 86369ed2a723e202afeac70bd92c83ca4efe5a66c1efd1f443bcfc7d41e6f838 |
| 0.59.0 | v0.59.0 | 4e3f91d21c524319469a9d452342cb7f3fb96cb864f176911742c318b49c6390 |
| 0.60.0 | v0.60.0 | d11e56cb0e7e18865511464330f4203d9ac2529cc8f376f66766dc9405bd0a90 |
| 0.61.0 | v0.61.0 | c9779b7ec1697e5d3b619d9eb47f98c87b55f819218f528342c97a519b957382 |
| 0.62.0 | v0.62.0 | 8a449ac688d52da001ea174dc2e635a02ca7b566b1665bd087d04359130b0d72 |
| 0.62.1 | v0.62.1 | c3983958b62d05f5510ca30bd853f5a0a0e50c8e177df9930924a1bb44699e53 |
| 0.63.0 | v0.63.0 | 1df80cb60d48f4175a01faec2c2b5e95c21bfaafdd8b7f5e78b3dd7001e0de42 | lij-sm.js 7543d40924352cf87685296cf5302cdb650110c32d3ce9afdda49a7580aaf615 |
| 0.64.0 | v0.64.0 | 1df80cb60d48f4175a01faec2c2b5e95c21bfaafdd8b7f5e78b3dd7001e0de42 (unchanged from 0.63.0) | delegate.js 3bfefceb3e8f61865106bd01c62d2399fe493d8ddefa923362a76911dc9b4147 |
| 0.65.0 | v0.65.0 | 253595c44aaaeeb704fda54d7876cd41932a0897e2f9b6780955b831737d1dcf | delegate.js 3bfefceb3e8f61865106bd01c62d2399fe493d8ddefa923362a76911dc9b4147 (unchanged from 0.64.0) · lij-sm.js 7543d40924352cf87685296cf5302cdb650110c32d3ce9afdda49a7580aaf615 (unchanged from 0.63.0) |
| 0.66.0 | v0.66.0 | 42672bd9259dea1f5daa8f3ee62252556f88687cebd69b6a09545344c5534567 | lightning-openchannel.proto 25429e1b8c355025896a432e6ffbc1b87e712edfc074d32c2bdf46eeb9b80927 · delegate.js 3bfefceb… lij-sm.js 7543d409… unchanged |
| 0.67.0 | v0.67.0 | 75e5c8aee289e2842f62d2f0eda724aaefc9e9243875990ea27cb7e3330f2509 | proto 25429e1b… delegate.js 3bfefceb… lij-sm.js 7543d409… unchanged |
| 0.67.1 | v0.67.1 | 844818f96ca0dbee715cc01b90f135a2892ba30c731386d8aab1124432ed8288 | other files unchanged |
| 0.68.0 | v0.68.0 | 063ef060e6280bfa5e1058272027b133a9a6869a6fdafb36d04ea63cc1a3a50a | other files unchanged |
| 0.69.0 | v0.69.0 | 501edb14a02264ad4f0b60b29490590c750f9eaf2cebf9b1bd5a7a4398dc7adf | package.json 0.69.0 · config.env.example (knobs renamed) · other files unchanged |
| 0.70.0 | v0.70.0 | 6f1b795745f3fd6f13532dbc11dce935e30dbe50533158a78aa454b3e084e2bd | package.json 0.70.0 · other files unchanged |
| 0.70.1 | v0.70.1 | 865419b3a333742a023367c80ab26aaf0d06dad9aa59557efca74b4d53c16ed5 | package.json 0.70.1 · KNOWN-FINDINGS · other files unchanged |
| 0.71.0 | v0.71.0 | f5a1c93d1013c97512aa84e0da8ad6f74a44ddab7b49f66e94c7d27e2d59fc08 | console.js 0b51d26462d01f29af09e8eae9357132ac478a949f4524d0832f98b297406963 (NEW) · console.test.js · package.json 0.71.0 · config.env.example (+6 keys) · other files unchanged |
| 0.71.1 | v0.71.1 | 25616b1f7eb5ceecddd44426ac1896bc6662b175ea20284d2ada6ccbb44b510d | console.js adde2559ba798334bf34c4b8d3a4e77c407978043adb734ed2a72af76148828c · package.json f7d494e41f1c77dbb8d6c4e24551907f83d57b8156532d2d37de424fd00f5889 · bake-permissions.json (+GetTransactions, +PendingSweeps) · MACAROON.md · other files unchanged |
| 0.71.2 | v0.71.2 | 8a0dc5f71f46813fc93471369555bf172844e4f3407aa6021a720286c6af0362 | console.js 7fa2998bedc6b89f6419ec811cd9070fc491e38b0cd2c95e7efa7624e1e06979 · package.json 4540046b2418dc6d84e553ae10fbcae128d11caee49c0a0db973fbc17812c14e · other files unchanged |
| 0.72.0 | v0.72.0 | 20619520361498bcd3a26ae283d97d55c891f8ad3ccea1c0e07f97f013b613fb | console.js 8c2b952f53bc57271453f0abcef0648ab612907014c6d29a95b95cc6392d9014 · pl.js cb83dc0583f678868cc7ad16db43dd9229b4dde72dc6c821465c2a5a6821a750 (NEW) · pl.test.js · package.json ef64ec6126c5e351ce6adac45d275672763fd896e2c9da8eb2da328c82c374a3 · bake-permissions.json (+ForwardingHistory, +ClosedChannels, +ChannelBalance) · MACAROON.md · config.env.example · other files unchanged |
| 0.72.1 | v0.72.1 | 20619520361498bcd3a26ae283d97d55c891f8ad3ccea1c0e07f97f013b613fb (unchanged from 0.72.0) | console.js 4d9db7e8d8455597db959b11294c88eb4100784e32fd809ba3bcf383a63f0ef8 · package.json 7ecf683d1f7fc5c431f96ec7959bc543562147369d7b4106eae232cbfa8091f9 · other files unchanged |
| 0.72.2 | v0.72.2 | 49e6bbae86b424d88614af0f0e73c6884c9c86f1ac1fc37df4c0ee8b736e9246 | console.js 4db4d562f0c48d34fef95c08bfeb9809a3c0318a58ad0524cfb1fb1c0dcedd53 · package.json dc089df26068c2f3f1a5b4cd5acf0d7967be7bebfd9bda11078df5740595aee2 · other files unchanged |
| 0.72.3 | v0.72.3 | ba33eaef96341e2e352c391b6031d9df5cfec2d1e4be1a6b3897f33da8e9d77a | console.js 4db4d562f0c48d34fef95c08bfeb9809a3c0318a58ad0524cfb1fb1c0dcedd53 (unchanged from 0.72.2) · package.json 9042f5f195bb1b67a632422352b69d4624129e21c93f6cea96439e342c426ea3 · config.env.example · KNOWN-FINDINGS · other files unchanged |
| 0.72.4 | v0.72.4 | 365dcf1269335829df0f9b3cfc906bd3aec25ccde78e7da001eb861545829ae8 | console.js e11ceb9d21aff83fcfd0e3cb6aeb16017cfa48f19cddf967cd52cb5181db48f1 · package.json fd4618b0424a2ca067959b8e082e81b109bab995c8de88236c71c660a109e148 · .gitignore · config.env.example · KNOWN-FINDINGS · other files unchanged |
| 0.72.5 | v0.72.5 | f0cd7e303e288b2f2afa5228ad047291d72a2796404b692aa0d649c145349871 | console.js 78a675dc9cec394dd5ee5f1d47d730a50b7d8ca890d9bb47bd487c1469fbbb1a · package.json e27f3411d143f5610d2841f0b215df03a836cd05f3450c53f687f68dfcfd0e14 · other files unchanged |
| 0.73.0 | v0.73.0 | fd1024ea7211cae5c65b853d8df718e421ccb34b9634be1d0c28606af4699803 | console.js 2d839d133a27244dc0876a31ae3dcdc1399318549491563d34263443b5f66176 · cooperative-chain-bridge.js 8be70d5d6bec3c620971f6b04c9c5a0dfc6d3dc4f77d8205ec990cfc9e8993d8 · package.json f339a4f2c0a3879e9d50d80d907c9a9af3eb97f812430775101f9b789ce98cff · .gitignore · config.env.example · other files unchanged |
| 0.73.1 | v0.73.1 | fd1024ea7211cae5c65b853d8df718e421ccb34b9634be1d0c28606af4699803 (unchanged from 0.73.0) | console.js 9500b14a0cd7511a2aef52f71f38aede70ae2852539c799a11c274ff102eade4 · cooperative-chain-bridge.js 8be70d5d6bec3c620971f6b04c9c5a0dfc6d3dc4f77d8205ec990cfc9e8993d8 (unchanged from 0.73.0) · package.json fbaa5be931126b31be1ca6bf67b08b5fc3621b00889759809ce08002bcc90f75 · other files unchanged |
| 0.73.2 | v0.73.2 | 6a4776d2df450879639cbd92d4f10620d449e09e6cd5d892f449339a8f02db82 | console.js 151d8f2de3e445ab5d0ce7f8b875246133e56991500e27b0546dbcbddeb319e6 · cooperative-chain-bridge.js 8be70d5d6bec3c620971f6b04c9c5a0dfc6d3dc4f77d8205ec990cfc9e8993d8 (unchanged) · package.json 4adc397e59844151395a67c07597001d802f55c9dc2c2ccc7b86d984cf3574ae · other files unchanged |
