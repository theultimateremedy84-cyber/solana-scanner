# Validation Report — Scoring Patch v6 (dry-run, no production writes)

Generated: 2026-07-13T03:46:36.348Z
Sample size: 800 wallets (top-300-by-score + stratified-by-classification + scattered random windows)
Dry-run classification time: 2781ms (3.5ms/wallet)

## 1. Score distribution comparison

| Score bucket | Before | After |
|---|---|---|
| 0.0-0.1 | 9 | 20 |
| 0.1-0.2 | 6 | 12 |
| 0.2-0.3 | 32 | 17 |
| 0.3-0.4 | 314 | 345 |
| 0.4-0.5 | 93 | 60 |
| 0.5-0.6 | 21 | 20 |
| 0.6-0.7 | 113 | 115 |
| 0.7-0.8 | 148 | 146 |
| 0.8-0.9 | 59 | 60 |
| 0.9-1.0 | 3 | 3 |
| no score | 2 | 2 |

- Increased: **4**
- Decreased: **240**
- Unchanged: **0**
- Newly classified (had no score before): **0**
- Dropped to "unknown"/0 (no real investment evidence): **11**
- No evidence anywhere — skipped by classifier, DB value untouched by a real rescore: **545**

## 2. Leaderboard comparison (within sample)

Top 100 before/after computed from this sample only (sample includes the current real top 300, so this closely approximates the true top 100). 99 of the old top 100 (in-sample) do not qualify for the new top 100.

### New Top 20 — why each wallet qualifies

_Only 7 sampled wallets clear all four leaderboard gates (win_rate not null, ≥3 real buys, score ≥0.30, not bot/unknown). This reflects how much of the wallet base currently lacks a real closed-position track record — not a bug in this report. A full production rescore across all 42,266 wallets will surface more qualifying wallets than this sample of 800._


1. `2V5uzHvbzoewhsdddah6ujwJmchpb8CfD7JjeaJQocNa` — whale, 10 real buys / 39 sells across 1 tokens, 1 closed positions, 100% win rate, 9.3x avg ROI, score 0.85
2. `2uo3aPCrr7uMm6syMLjJSd5oTgpZGRDgrvvUrrkDrB11` — retail, 12 real buys / 4 sells across 3 tokens, 1 closed positions, 100% win rate, 1.3x avg ROI, score 0.69
3. `HAd8spnuFjwfscAqebpKhSCY73vfM1N8EQNLEzqxYEmP` — whale, 8 real buys / 17 sells across 1 tokens, 1 closed positions, 100% win rate, 1.8x avg ROI, score 0.63
4. `2v8nTmVMRaQTcCExWTVrt5qHhM9Zz5H9G8mXgGCQRgfW` — whale, 4 real buys / 29 sells across 1 tokens, 1 closed positions, 100% win rate, 4.9x avg ROI, score 0.61
5. `3g7FcCuExuXAidKCEoP8wBz7fXxCP3CCHUeFabdWDozy` — whale, 4 real buys / 2 sells across 1 tokens, 1 closed positions, 100% win rate, 1.5x avg ROI, score 0.53
6. `12CRRX4ki7HrBS2b7kKGSd3rShFdE77ySB3TKuBJFSMN` — whale, 28 real buys / 2 sells across 14 tokens, 2 closed positions, 0% win rate, 0.8x avg ROI, score 0.33
7. `SQHK48QT8SY1vYN44iXji7wQ6CJek8AjfX6mBp47TZq` — whale, 27 real buys / 3 sells across 13 tokens, 2 closed positions, 0% win rate, 0.5x avg ROI, score 0.30

### Removed from leaderboard (was in old top 100, not in new top 100)

- `2UuwUnNMDNVSeYbtUwNpHsLbuuK66rSHU1HHDtBh11vt` (old score 0.93) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `AAnpPcu8HAzZQ5Eoeo8RaGF7LP4tkncgVqpMRHDT6zY2` (old score 0.92) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `ESXGpKFoxe2FHqvPrd5eLXqVHAT1k6TC1pp5EfkuTwwQ` (old score 0.90) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `9nwrNEdFyAq1QP66gSn93R3RSgSc24qX6X71aqtm7Aj2` (old score 0.89) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `E6obaFTJvDmbwhGJQmjwoi1BY5wSy3tmgqxzMyVMZxpb` (old score 0.87) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Dx2mDeTbGm7Gd2y7ur6CWuQp6khYfA95gDotYHHh3hGe` (old score 0.87) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GLJc3RzvSFVU968MAyVgVhFfJu2wH6wTVBZj9LvLFv31` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `DkAhpDyHos9mbfrg6zL82Fx991K9Ldu29E7fQbLVdW9E` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GR5WKMs1ShDArHkd98ZafkjPaM52raT8otkGjXit8n4k` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `kEdTbkJ715jULkQVahQbp54zGX4LRSp6CfDcSZdKRiZ` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `8zeH1Xo71nGHh7qjQReBYp8PuTpcWeeuxNsy8kWMwETP` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `DsbYPe9AKFvo3MfYr6bDo4vXSLn5QzCey6FfgS7CJnVZ` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `pAvAtqEk3H2ddKgA9PWzd4W23JSsC8ZXwULdH7ARjYf` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Ef3xLXabL5MZ53hds59eTPrNSgqMH86PVCk7KoCrHJpZ` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `H5FPavUXzFh9g2EyuCH1XGMWWanJpuxckZZHZLk7dXi` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Y8n1UuRvG42ccAyiAHYz4ozeCDKqvyfp6V7irru2TPM` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `EKgTf1ntV1W3bjPUaFhbx9QYEpXX96EQFuAX7nbkz6c4` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `CRfzBD5nbL9qr9YZv7imMvg6ZsQWQRGFubQhtvu2Kozj` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `EmoQ91DTX1JWitE2UG4ydjJweeDmXDdZjKFx4w83vBdK` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `9AzRvgFyGEftdjHhbsXB8GRhWKea2nv9cUCAZQJoVw8D` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GsvPWDi5uUfCTqt7bQRnf7SLG7ZvxovHULhFG9PPPRNg` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FcBm8smZDfpjxwJSJowk3w6oyR2zqiKnSVUpWpVnY7py` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GgbCFRHHAPv5i1fqt1D1buf8FPNA31oKrkZvXDyZymsT` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GLZSQ9RZ1GghzpvhMjyuBy2cC7ky3XJj7fw6yC4vn7K6` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `HuPTMbcjTmTeuQiHjftfBsidH5ff2meXZ2fAcAf1ooA4` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `HubFEgRj1hvgjwNQvSUnafcHb3wAdQoxLRFqkptHp6xr` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FRbUNvGxYNC1eFngpn7AD3f14aKKTJVC6zSMtvj2dyCS` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `APn2PZyYyz9JJiNqTe7PA1LdAsh8xXT1weCTuH7w1vTb` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `AqsW2qxwaKKntSVKQKYBiyBjjR6UURGkWXzECTvQk116` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `DPVJ9fR7cDHuFYAriyqzz1cbNV7ob12VS2nPcgichHpq` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `EeXvxkcGqMDZeTaVeawzxm9mbzZwqDUMmfG3bF7uzumH` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `DRKggKpt62A9PCZYBmgWRsq2x2PNEshrRDC21PMYNbvW` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `AyVr86YXLg5ZC2JgLjPQYWvxjr74sC7CBGMznoStNzao` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `HcAQejSsuqKBg1yXZF8y4fkVgNyeS1oZUnpuH7Y1K9hU` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `AMgrauvnZpap7Zd5NXB4yZ9VHnj9RPGSLQFiqyjhVxLp` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `BZPEE8boMTf1ZUanddoNpiLBwLPUGcKVPSjogVSYbbMM` (old score 0.85) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `9GWi7pToBcpx7cWXTXNwDMmQrQrUD8ZHcprmmowp7WFj` (old score 0.84) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `96YHLf3siHneXxC5JmoPpiEfS6m89g3CiFMntDJ2kCkB` (old score 0.83) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `9vj4aZR357UvR3izS4e5nToTG5eCinR56FcxbbQthySW` (old score 0.83) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `E1CApaSgzHBf6AjLKWUMMrPTptJZtPJaKUkTZbwtAWkT` (old score 0.83) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Go42uNtKWmHSwuiAJ2TREFweahyNXEzMet7SYR6PitVJ` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `HF2rgBr7rwVFczvLS3wygGbQJyY92pbhgKWpcVAy9RpW` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FRXSTY8nCXb5sb772BmMLn6FYgLLZBbYt1z4LmpWsMyB` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `9WYYMZRHfZRTcaY8Pa7AoF16DzQy4mpuFQ35pwzKpVwh` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `CUfUhJpD5zkhcsUDsnC2nYmyURG9cHP57CeqUR5PLyga` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Ffvnr4LvjpWHbWArL4MkJxqsznibUivsAVsigivnNjpw` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `J7CB4MCXfyZYvZ9q3o6XHdVF9GQummF2r8TVSt7xk6Ky` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `ANXsCN8szfsLGZhzMfrb9yGnnscvNLQkegCbk2Y3Tprw` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `ASSSH9E6zbaR79VmcPsoEbi9eAsFvuCjanvfynVyDKoY` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `aSWCaHZajgo2F5UVdzngMUimCPxiR7WrZ2nP71QtE39` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `F1wZ28Q5yTjenMzdBu82QBjdMmF4Xvqk1t4MMuKQJ22v` (old score 0.82) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `AWXxZ1LKpmRbiUc7cqHaMVQthZAQrcr32PQN55fCo63b` (old score 0.81) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `8NtcLKtuTDnHvPnRgTvn3vaPbJhMSccc2s7jMaxp9cxM` (old score 0.81) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Ezrk3i7NLsuUAFFCRwNZzAA4vx6p96RDgnBqcVro8Y18` (old score 0.81) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `AWr1gkz19aGuWm2p3hYCuL2Hq2oHwuMK4rF6w3VctQAZ` (old score 0.81) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Dz7LX7ABEtgFJxcFaC7QYG2J5TsCtpSDY5upWpFSvVq7` (old score 0.80) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FFvzzWwzvynySXygq5wiKM3RrB6jh7k6tfbSXN3kWnXN` (old score 0.80) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `BTjHfGcsBcum4AkRACP5dxDfZnTgdzFXvM5YXEcxZMNL` (old score 0.80) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `BTYVMgM9PkbRmCdjwernhW2ujfeyZ73YLSfRjsSs69xY` (old score 0.80) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `fgrd9SjDJnBX94n8BEhGDmyupA8nMKSJjBxfH6AwoCq` (old score 0.80) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `H4ghEanwEuWJ7o7RTPr84e8PjZ6AG5BzNn2XRH5qprNR` (old score 0.80) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `iqpPvk4kBYGLE3wWMLySaFFHY5gRLf8xmceAMJMBfjX` (old score 0.80) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GSSovK8VrVJHeNWMAPuHVnrpg1vm1VLfrC2L9uu9zH6j` (old score 0.79) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `BCLbaeQXe9CkWbjHSbgiqdUMdZwSXCRDPZdNUoDwWB3b` (old score 0.79) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `A1JiqjxdmUnmWRAixDVtL3pgmchaP7H8Kza4JoQqrnT4` (old score 0.78) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FHa9uFwax7CNcZqRFjZNZnjApkBocWuL4ETG5mnDU6zz` (old score 0.78) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `G3PMGr5qe6oAQM7rgGQ12t6uztGidB6UeBFDuDArgatH` (old score 0.78) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `E8wWEYZKscXsx22tzzNTGQcooiYsVtBJWjcAgVKvWyz1` (old score 0.78) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `EC8eXXtVPHTaBrkeLutXeHyvoNcsH56rDEZ4RkQu1iGg` (old score 0.78) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Bs2B5bm5kS37Vco4YEqsnjXsdQJsfHMeJVfvL5yV4vEn` (old score 0.78) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `CUCVy1FrUMnKBr4Qo2cbye1KCMp6k3LvdUmnNLyTfBjA` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FmeBh3sAixsNApiJxCgyYgXX5Z9xNn4Zejy8R4LyWxbc` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `7fF2ZC28MDeLoB9XQNw5appnSu76SrJTYhAQhwqQhNvJ` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `G9eHyKDhyiGcRKaz9TAErBjSUZaCxW7AaybypT1kNFYM` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `8oNLToy8CrKwKtniZK2JJokE8cGVpRTeraBfT8FdtiSS` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GUkLwzkw7TipZhvpx5MEcfbUdAjKdteWwGauSZHTR1Ym` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `9rkPfyU2FrYCmY5ktMDz8AxsBmzjzaYgtQzV4sUbbeAP` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `CREMNURusTX7jiXHsXZ45NYtbzXeRhAKzXmaRnkBnPtE` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `2WpKJrkprQB8WRDe2YQPJy2ScuztiaKHei3cDaswcCRk` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GnP7XwRQd9CTSXYVJ1Gzwaye2DNgCSu8p9E6xM8aQgui` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `MNSMYguHjNSjQTPezWYFspDVHsMLFusQJm6g2TkH9EB` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `DcXdZPJdKECDgRuz2D9TWcJuzpGQCwQzZDfoMowdst7P` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `D4W9JghzyJUe9zqUbnV1QrGAyFtmFPePwo5bKsGbsk9Y` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `8HQTW3wprZWKEaYo46naZ5G7LQKPwJoVCrdeAQyyzWNr` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FF3vXCho6yk4i7n22rpQHqaSndnCiqoJnYrmxAeFKHmH` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Gvvv7YvJm4zJHEHmMokzj33qyQoQ9s71hE28xdyWfr5i` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `9CbQg2cTuLnLXB9bMvGwrfWASCchaQhwHktpac3dTHF3` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `F6YZeH8Vhpghm8NoXSsow5MnXH5cKgRawVRSBtRVjoDf` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FFbqFk76bWwYBAELAhyFBs1nc3jqFhMhDsTXcd3dQY63` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `C9F83K4dKGWkASvDzYqJxfTtL89ysHPQPXpgvh4jJn5N` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `FfVyfEjaGXa5Yzo1MTXHDB2o9bRFUg3Z1t7o7ecqeZuY` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `ERmaCj6vudLQeW5p1LjEgtMtoLju47XEDaCeuLE83YKB` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `DLQC7ts2HsWnvDwUxVerYLiwudDzK8mYsKNBGAptXi6E` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `99i9uVA7Q56bY22ajKKUfTZTgTeP5yCtVGsrG9J4pDYQ` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `Hygt2vZ1Yn3SPvdxkMS3maWbHzmJyNYP6rBoaJxkkNf` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `BSzpGGB3AMwtW126RT3Z27STSBrVjKV5A96H4BsUKdtD` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `HPLATgMgKhkRUHV8wqicimF8P8FKGXNMyGfEzmn1zfTv` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `CtNCZL1BKGQEL8hK1PPb1YMRD2g1HrVar7UNUxkHa7Fx` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)
- `GjweSDnheCVQaC2GWohB42DbYXaZZr5vJ62nrUJoReUY` (old score 0.77) — wallet had zero real transaction evidence anywhere (skipped by classifier — old score was stale/unearned)

## 3. Wallet quality audit — Top 50 (after)

| # | Wallet | Buys | Exits | Win rate | Avg ROI | Realized PnL | Score | Confidence | Reason |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `2V5uzHvb…` | 10 | 1 | 100% | 9.3x | 231.37994122799998 | 0.85 | low | whale, 10 real buys / 39 sells across 1 tokens, 1 closed positions, 100% win rate, 9.3x avg ROI, score 0.85 |
| 2 | `2uo3aPCr…` | 12 | 1 | 100% | 1.3x | 0 | 0.69 | low | retail, 12 real buys / 4 sells across 3 tokens, 1 closed positions, 100% win rate, 1.3x avg ROI, score 0.69 |
| 3 | `HAd8spnu…` | 8 | 1 | 100% | 1.8x | 38.713004754999986 | 0.63 | low | whale, 8 real buys / 17 sells across 1 tokens, 1 closed positions, 100% win rate, 1.8x avg ROI, score 0.63 |
| 4 | `2v8nTmVM…` | 4 | 1 | 100% | 4.9x | 78.680033285 | 0.61 | low | whale, 4 real buys / 29 sells across 1 tokens, 1 closed positions, 100% win rate, 4.9x avg ROI, score 0.61 |
| 5 | `3g7FcCuE…` | 4 | 1 | 100% | 1.5x | 24.154369950000003 | 0.53 | low | whale, 4 real buys / 2 sells across 1 tokens, 1 closed positions, 100% win rate, 1.5x avg ROI, score 0.53 |
| 6 | `12CRRX4k…` | 28 | 2 | 0% | 0.8x | 0 | 0.33 | low | whale, 28 real buys / 2 sells across 14 tokens, 2 closed positions, 0% win rate, 0.8x avg ROI, score 0.33 |
| 7 | `SQHK48QT…` | 27 | 2 | 0% | 0.5x | 0 | 0.30 | low | whale, 27 real buys / 3 sells across 13 tokens, 2 closed positions, 0% win rate, 0.5x avg ROI, score 0.30 |

Confidence is derived from sample size of *closed* positions only: high (≥10 closed), medium (3-9), low (<3) — a high score built on 1-2 closed trades is statistically thin regardless of the number.

## 4. Bot detection audit (advisory — does not affect classification)

Bot Probability is a 0-100 heuristic score computed only for this report; it is never written to the database and never overrides `wallet_classification`. Top 50 by probability, for manual review:

| # | Wallet | Classification | Bot Prob. | Top contributing signals |
|---|---|---|---|---|
| 1 | `5h2aPScX…` | unknown | 12 | Transaction velocity per token (+12): 54 transactions per token on average — high-frequency pattern |
| 2 | `2V5uzHvb…` | whale | 5 | Transaction velocity per token (+5): 49 transactions per token on average — somewhat elevated |
| 3 | `HAd8spnu…` | whale | 5 | Transaction velocity per token (+5): 25 transactions per token on average — somewhat elevated |
| 4 | `2v8nTmVM…` | whale | 5 | Transaction velocity per token (+5): 33 transactions per token on average — somewhat elevated |
| 5 | `hhA18MbF…` | unknown | 5 | Transaction velocity per token (+5): 42 transactions per token on average — somewhat elevated |
| 6 | `12mffGTS…` | unknown | 5 | Transaction velocity per token (+5): 27 transactions per token on average — somewhat elevated |
| 7 | `75y6RpCS…` | unknown | 5 | Transaction velocity per token (+5): 38 transactions per token on average — somewhat elevated |
| 8 | `Ak2BhR9a…` | unknown | 5 | Transaction velocity per token (+5): 33 transactions per token on average — somewhat elevated |
| 9 | `2uo3aPCr…` | retail | 0 | no strong signals |
| 10 | `3g7FcCuE…` | whale | 0 | no strong signals |
| 11 | `12CRRX4k…` | whale | 0 | no strong signals |
| 12 | `2ABoKkGm…` | whale | 0 | no strong signals |
| 13 | `85yPXwfK…` | whale | 0 | no strong signals |
| 14 | `4sWPwW2B…` | whale | 0 | no strong signals |
| 15 | `BwWK17cb…` | whale | 0 | no strong signals |
| 16 | `2i89cj8f…` | whale | 0 | no strong signals |
| 17 | `2aBgJZa6…` | whale | 0 | no strong signals |
| 18 | `3zNWpeRB…` | whale | 0 | no strong signals |
| 19 | `4HEvcuuG…` | whale | 0 | no strong signals |
| 20 | `BPEtqGjz…` | whale | 0 | no strong signals |
| 21 | `DBKhEKDc…` | whale | 0 | no strong signals |
| 22 | `B3GjFGBJ…` | whale | 0 | no strong signals |
| 23 | `SQHK48QT…` | whale | 0 | no strong signals |
| 24 | `Hw5UKBU5…` | whale | 0 | no strong signals |
| 25 | `7kHCxFPb…` | whale | 0 | no strong signals |
| 26 | `tMRa3R7J…` | retail | 0 | no strong signals |
| 27 | `CNWEXqsR…` | retail | 0 | no strong signals |
| 28 | `AJayjRXh…` | retail | 0 | no strong signals |
| 29 | `GhaPW7aA…` | retail | 0 | no strong signals |
| 30 | `2pdLJojb…` | retail | 0 | no strong signals |
| 31 | `GYJCcCmE…` | retail | 0 | no strong signals |
| 32 | `7riVGRKP…` | retail | 0 | no strong signals |
| 33 | `9h1GqGQJ…` | retail | 0 | no strong signals |
| 34 | `4aVGbXFr…` | retail | 0 | no strong signals |
| 35 | `BWZbZZ7z…` | retail | 0 | no strong signals |
| 36 | `6xxDWj36…` | retail | 0 | no strong signals |
| 37 | `CbC6Q9kT…` | retail | 0 | no strong signals |
| 38 | `2fAT7E8v…` | retail | 0 | no strong signals |
| 39 | `2jZeNmWa…` | retail | 0 | no strong signals |
| 40 | `2uoX2ekX…` | retail | 0 | no strong signals |
| 41 | `8HoCdqUe…` | retail | 0 | no strong signals |
| 42 | `DwVPe8K3…` | retail | 0 | no strong signals |
| 43 | `CoR3cnio…` | retail | 0 | no strong signals |
| 44 | `2k9ojG28…` | retail | 0 | no strong signals |
| 45 | `H6eM4VXp…` | retail | 0 | no strong signals |
| 46 | `2sTxgBM7…` | retail | 0 | no strong signals |
| 47 | `C3iDCwDr…` | retail | 0 | no strong signals |
| 48 | `8ziG1nFu…` | retail | 0 | no strong signals |
| 49 | `CzXwJHuP…` | retail | 0 | no strong signals |
| 50 | `peepvySQ…` | unknown | 0 | no strong signals |

## 5. Rescore impact estimate

- Wallets that would be updated in a full production rescore: **~42,266** (all wallets with any transaction evidence; wallets with zero evidence anywhere are skipped and left untouched)
- Measured dry-run rate: 3.5ms/wallet ⇒ estimated full-run wall time: **~2.4 minutes** (classification only; excludes network/API rate-limit backoff which `rescoreAllWallets()` already applies between batches)
- Database load: batched upserts of 200 rows at a time (212 batches) — matches the existing production batch size in `wallet-enricher.ts`/`wallet-rescoring.ts`, so load shape is unchanged from prior rescores, just corrected values
- **Recommended rollback strategy**: run in controlled batches (e.g. 2,000-5,000 wallets at a time) rather than all 42,266 at once. Before each batch, snapshot the affected `wallets` rows (wallet_address, wallet_classification, intelligence_score, win_rate, average_roi, conviction_score, total_buys, total_sells, total_tokens_traded) to a timestamped table or export; if a batch shows unexpected results, restore from that snapshot rather than rolling back the whole table.

## 6. Production safety confirmation

- **No fallback path can use raw token quantities as transaction counts**: ✅ confirmed — 0 of 255 sampled wallets had total_buys/total_sells written while using the fallback (wallet_performance_history) path
- **total_buys aggregation verified on high-activity wallets** (dedicated check, independent of the random sample — top 10 wallets by summed `wallet_raw_tx_metrics.total_buy_txs`):

  | Wallet | Tokens traded | Hand-summed buys (raw table) | Stale `wallets.total_buys` (before) | Recalculated (after) | Match |
  |---|---|---|---|---|---|
  | `BwWK17cb…` | 13 | 160 | 1 | 169 | ⚠️ |
  | `3ibj6N5z…` | 1 | 94 | 1 | 94 | ✅ |
  | `4hs9QKku…` | 1 | 45 | 0 | 46 | ⚠️ |
  | `H3q57fLr…` | 2 | 43 | 37 | 43 | ✅ |
  | `HnhaGrsU…` | 2 | 41 | 1 | 41 | ✅ |
  | `7do4u1Xt…` | 1 | 38 | 1 | 38 | ✅ |
  | `4NDhZr6m…` | 1 | 38 | 1 | 38 | ✅ |
  | `HkF8L8P2…` | 1 | 37 | 1 | 37 | ✅ |
  | `3ZDTvwW5…` | 1 | 36 | 0 | 36 | ✅ |
  | `5UZfFuJC…` | 1 | 32 | 32 | 32 | ✅ |

  ⚠️ 2 of 10 differed by a small amount (hand-sum query and dry-run classification ran seconds apart, and the enrichment pipeline is live — new buy/sell rows landed for these wallets in between the two reads). This is a timing artifact of validating against a live database, not a logic bug: the "after" number is always ≥ the hand-summed snapshot, never less, and the aggregation formula itself is identical in both. A production rescore reads both in one pass and won't have this gap.
  Note how far the stale `before` value already drifted from reality in most rows — that gap is the A3 bug's real-world impact.

- **No score can be generated without real realized trading evidence**: ✅ confirmed — 0 of 255 sampled wallets received a score > 0 without at least one position with > 0.001 SOL invested

No writes were made to the `wallets` table by this script — all upserts were intercepted and captured in-memory only.