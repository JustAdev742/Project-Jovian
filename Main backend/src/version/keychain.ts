/**
 * Per-build cosmetic chunk keys for GET /fortnite/api/storefront/v2/keychain.
 *
 * GENERATED — do not edit by hand. Regenerate with:
 *   node tools/aes-registry.mjs --archive <extracted Fortnite-Aes-Keys-Archive-main>
 *
 * Source: Fortnite-Aes-Keys-Archive (supplied corpus). CONFIRMED — the archive lists the keys
 * themselves, and 7.40's two were verified by hand against the running backend on 2026-09-05.
 *
 * These are the SECONDARY (per-chunk) keys the keychain endpoint serves as `GUID:base64(key)`.
 * The primary key that mounts the main paks is NOT here and is not served by this endpoint — the
 * build already has it — so it is deliberately kept out of reach of a route.
 *
 * Keys the archive records as `???` are omitted and counted in `unknownChunks`. A build with
 * gaps serves what is known; the cosmetics in the unknown chunks stay undecryptable, which is an
 * evidence gap rather than a defect. Inventing a key would fail in a way that looks like a
 * decryption bug rather than a missing key.
 *
 * 75 builds · 634 keys · 66 recorded unknown.
 */

export interface BuildKeychain {
  /** Build string as the archive spells it, e.g. "7.40". */
  build: string;
  /** Ready to serve verbatim: "GUID:base64key". */
  entries: string[];
  /** Chunks whose key the archive records as unknown. Informational; nothing is invented. */
  unknownChunks: number;
}

export const KEYCHAINS: readonly BuildKeychain[] = [
  {
    build: "7.10",
    // chunk 1004 — Lace Skin and Set
    // chunk 1007 — Eternal Struggle Set
    // chunk 1009 — Crackabella
    // chunk 1014 — Red Nosed Ranger
    // chunk 10?? — DJ Bop Set
    // chunk 10?? — Grimbles Backbling
    // chunk 10?? — Grimbles
    entries: [
      "C7623A35411F3D5FBDE2688C7E4A69EB:qAi49mUKsB2dbfbtJWDf3yO2DfRStA+Ed9XgDjC8Zaw=",
      "57D2C065461284F546C48C971A44C6D0:EOfb/g0hZdMhd5biYOZR69B/mqPU7X+sgQQrp2gQ/s0=",
      "09BC93B3441ECBAC30FA23BBEF59CF89:3CHInj+JfLspiVCNDY/GTZ4Pn52nWFeA4qYI0SJv2dM=",
      "32E8846645441197B80CF8B1C86B01A1:cwJgOQhsrscdiFfLHzS9WudnE9mBMH/C/SAyX81B2fM=",
      "8680408E4982495D8EC65D930CE902F3:ZIoca9gNSMll2u3zmmEsMFSAp2pTmsvWIPWwz2b0FsE=",
      "2CB7CC414F921DD774957AAF4AD5F8FE:vi2xluuUw+pFj/tqqfvh7cS9Qnr8gQPEGX0IHyjZVp4=",
      "854D0D9F4EF33FB4410CB98340952245:wYzInzYpL5IB6dN+rCo6196KgGGo3E/rNeOf7Paizz4=",
    ],
    unknownChunks: 0,
  },
  {
    build: "7.30",
    // chunk 1001 — Snow Clan set
    // chunk 1002 — Marshmello outfit
    // chunk 1004 — Pickaxe_ID_152_DragonMask
    // chunk 1005 — CID_336_Athena_Commando_M_DragonMask
    // chunk 1007 — Deep Sea set
    // chunk 1008 — Marshmello Event Visuals
    entries: [
      "1234642F4676A00CE54CA7B32D78AF0C:Nd8vhYp296C+C0TqSIGxu0nBYOFGQ5xBNK5MFjHS8IA=",
      "1C8FA86241B2E4D084F7548529629CF6:pmXOfd+NEXcLhZX5YqDLjHu8/yzZoo4dWPcCM8ccXoI=",
      "2B245B0F4DDB6AE9929DEDA081BEA512:lVz6HM71lNhCrT167xXv2wjekx+NqrJcy15i2+w3FdE=",
      "6ED300E6401C02B19FDF5F82D945C661:OVr0GWPGv86nzWikKzrw2SC4aS+4ApgKKLvQ7d0Nkn0=",
      "91C415954BF27B6E43970FB8A75FE8BB:YhHyxIA+Ru33r3pThiWqKNYdvDbL05yXSxKarRuMSxw=",
      "A9AFB4A346420DB1399A2FB2065528F5:Zjzo+CaLNmCygplzQo2wUL4LT33DEiL6qZWE2R0EYMg=",
    ],
    unknownChunks: 3,
  },
  {
    build: "7.40",
    // chunk 1003 — Deep Sea set
    // chunk 1004 — Brite Blimp Glider
    entries: [
      "91C415954BF27B6E43970FB8A75FE8BB:YhHyxIA+Ru33r3pThiWqKNYdvDbL05yXSxKarRuMSxw=",
      "D776CA2A40FD9EC1F8522E9E13E99031:uRYulzQ2zdGG9UisQw2wM9OOM/9JsSWFwFt5d/3okng=",
    ],
    unknownChunks: 3,
  },
  {
    build: "8.00",
    // chunk 1001 — Hot Air set
    entries: [
      "71BEC74046C6920A467E57B69FA3835A:q6m1xB4+mCmXL3g7eRGykDO6ZKrXS8M7m8SqbqIKzkI=",
    ],
    unknownChunks: 2,
  },
  {
    build: "8.10",
    // chunk 10?? — Lucky Rider and Set
    entries: [
      "F6838AF4144E8386A184FBB0823C15D0:IjzqnnHjZ+r6WC4He/JawOyR7LxeMbm5880cDGDr2eU=",
    ],
    unknownChunks: 0,
  },
  {
    build: "8.11",
    // chunk 1000 — Diabolical Set
    // chunk 1002 — Mechanimal Set
    entries: [
      "452BEE39B4C18C93D6B185B565ACA1CA:Be2Oll2p0qIXmiJMi4Y/wyePY+WefMmJyCzjgjrzkhc=",
      "5950552B5A52A97A433715A1FF107BC4:p9RBdPmk5295pRSg0+Ybfwy/kqY6HBYiJEAkvy650O4=",
    ],
    unknownChunks: 0,
  },
  {
    build: "8.20",
    // chunk 1000 — Glider_ID_133_BandageNinja
    entries: [
      "0F810ABB0DB8672A438B14169C048145:9vfFUEaEveznaEvyq+mhGagh3w98fRdZ5BpwQgNzMzg=",
    ],
    unknownChunks: 2,
  },
  {
    build: "8.30",
    // chunk 1000 — Teed Off set
    // chunk 1002 — Bunnyhop Emote
    // chunk 1003 — Wrap_045_Angel
    // chunk 1004 — Wrap_036_EvilSuit
    entries: [
      "3E89561331A72D226FBF962DA29DBB82:qzWv2zubDSSrpTt3tKc4ZsReqR3QBKjhU1cGzVe7KH4=",
      "A93064DA8BDA456CADD2CD316BE64EE5:nziBPQTfuEl4IRK6pOaovQpqQC6nsMQZFTx+DEg62q4=",
      "BA4D882E7B09657A5E05773F702103CF:PjieN4lF3tRBNjQmWWUAyvZUaV0OrPGPYwrqNT8ZSus=",
      "D7727B4696A62373E9EBD9803F705B3C:XEbXIzCpOuA88jMBtt+XuMt+NaOIWlvfpW9h7i/dFlM=",
    ],
    unknownChunks: 1,
  },
  {
    build: "8.40",
    // chunk 1000 — Hopper set
    // chunk 1001 — BID_251_SpaceBunny
    // chunk 1003 — Nitehare Set and Dino Wraps
    // chunk 1004 — Wrap_049_PajamaPartyGreen, Wrap_050_PajamaPartyRed
    // chunk 1005 — Globetrotter Glider
    // chunk 1006 — Bunnyhop Emote
    // chunk 1007 — Wrap_045_Angel
    // chunk 1008 — Wrap_036_EvilSuit
    // chunk 1009 — Splode outfit set
    entries: [
      "4C838738CDC4946786DD7BE341AB05DD:eyjCm9OcFQSvVRVBZizNVyF+8kb9OlNFrvDy8d1QDfo=",
      "4F53A11AB9CD08FA18D603BF29415366:mq1giTyk7GAqrpXphg9STetDQnhFBS5M1SYEHM7uYqk=",
      "6CED8B5F648ED1ACCC8F1194901775AF:qjfCT39FVniEjPj+CvZu5Qz8XHHtdnH8kCsV3P1OaJw=",
      "768A95DE7B657B7B23D5A0DE283EB49F:JLLAz46a7wo2rADQvCkbp4IbKexr7J5bBr6d6toSn50=",
      "A2A3968C8EF4EA9F7979BC1FC57B871D:xVURN9OBgLtbyK0ZR4bqMgsZpL/SJjlIXf1WGEpfd6I=",
      "A93064DA8BDA456CADD2CD316BE64EE5:nziBPQTfuEl4IRK6pOaovQpqQC6nsMQZFTx+DEg62q4=",
      "BA4D882E7B09657A5E05773F702103CF:PjieN4lF3tRBNjQmWWUAyvZUaV0OrPGPYwrqNT8ZSus=",
      "D7727B4696A62373E9EBD9803F705B3C:XEbXIzCpOuA88jMBtt+XuMt+NaOIWlvfpW9h7i/dFlM=",
      "E59B013651F078E718F08ECF9E1559EE:rTGy9at5kTfQtu8EwVrUihfzuN8vkFPl3XNyGvqbZX4=",
    ],
    unknownChunks: 1,
  },
  {
    build: "8.50",
    // chunk 1000 — BID_258_AshtonBoardwalk, EID_AshtonBoardwalk, Pickaxe_ID_202_AshtonBoardwalk
    // chunk 1001 — Cole outfit
    // chunk 1002 — Arcana Glider
    // chunk 1004 — BID_254_ShinyMale, Pickaxe_ID_199_ShinyHammer
    // chunk 1005 — CID_397_Athena_Commando_F_TreasureHunterFashion
    // chunk 1006 — CID_398_Athena_Commando_M_TreasureHunterFashion
    // chunk 1007 — Rockbreaker Pickaxe
    // chunk 1008 — BID_257_Swashbuckler, Pickaxe_ID_201_Swashbuckler
    // chunk 1009 — BID_259_Ashton_SaltLake, EID_AshtonSaltLake, Glider_ID_142_AshtonSaltLake, Pickaxe_ID_203_AshtonSaltLake
    // chunk 1010 — Wrap_036_EvilSuit
    // chunk 1011 — Lunar Light back bling
    entries: [
      "216D955070ADAF10973BD156897472C3:MjQh55OvnJCoVMQzMU4C/1NF3FWiXDXnJ6G/EcHfUzo=",
      "2BFECCEDD463D908C63438FD751529BE:u3hXyyjFecUwcUQIugiOjqwSJhnhy/cluvLBwlUhSC4=",
      "46FC5EBAD39CE53EFB215A2E05A915FC:H3gtdkEzT3Dk8vkwTTZE9oUDoJEy6vmfQj1jDo453gY=",
      "56812D9CB607F72A9BDBADEE44ECCD21:pj9dMhJSaj6V2HsA0VWABE7Cs4+eEBz1Kex340gafK8=",
      "5B26536B2ACB973C651C0D1A285C0E37:n4j7xWZ1HfwSGb9ixE7YMFyRsTjl3gjJVDZJj7Wy4rs=",
      "7313591AB9F0A7E46AB016065DE8F65A:NAL0bLW1p+ceLF4lhxfm1vQPaMlv8eNPP6tTizTZEN0=",
      "8335E3DF8B0DFBCB0C05EFB5FF1B8A81:shx/UPd2PJpGZtpddRmoS7RosbEO0MlsaNb+9aaQR9g=",
      "B1B800E199A6D4649287C11AE89F67CA:3udFXffIw3c7eM5hljF5mJQA36FbW2PeF8Gx1TcD1vc=",
      "D49757E2D55451A0D5B341906FE2ABE4:PWMwnjgi/wUDV+yxg02QsU33jA529fxVTRHyqnkv21c=",
      "D7727B4696A62373E9EBD9803F705B3C:XEbXIzCpOuA88jMBtt+XuMt+NaOIWlvfpW9h7i/dFlM=",
      "F07BE27DCEFDF52818EE7BA2CD9CA504:lc47A/VahaBWJLQY4V1YyjzJPI5xVErInDaqdwPjv2g=",
    ],
    unknownChunks: 1,
  },
  {
    build: "8.51",
    // chunk 1000 — Cole outfit
    // chunk 1001 — Arcana Glider
    // chunk 1003 — BID_254_ShinyMale, Pickaxe_ID_199_ShinyHammer
    // chunk 1004 — CID_397_Athena_Commando_F_TreasureHunterFashion
    // chunk 1005 — CID_398_Athena_Commando_M_TreasureHunterFashion
    // chunk 1006 — Rockbreaker Pickaxe
    // chunk 1007 — BID_257_Swashbuckler, Pickaxe_ID_201_Swashbuckler
    // chunk 1008 — Wrap_036_EvilSuit
    // chunk 1009 — Lunar Light back bling
    entries: [
      "2BFECCEDD463D908C63438FD751529BE:u3hXyyjFecUwcUQIugiOjqwSJhnhy/cluvLBwlUhSC4=",
      "46FC5EBAD39CE53EFB215A2E05A915FC:H3gtdkEzT3Dk8vkwTTZE9oUDoJEy6vmfQj1jDo453gY=",
      "56812D9CB607F72A9BDBADEE44ECCD21:pj9dMhJSaj6V2HsA0VWABE7Cs4+eEBz1Kex340gafK8=",
      "5B26536B2ACB973C651C0D1A285C0E37:n4j7xWZ1HfwSGb9ixE7YMFyRsTjl3gjJVDZJj7Wy4rs=",
      "7313591AB9F0A7E46AB016065DE8F65A:NAL0bLW1p+ceLF4lhxfm1vQPaMlv8eNPP6tTizTZEN0=",
      "8335E3DF8B0DFBCB0C05EFB5FF1B8A81:shx/UPd2PJpGZtpddRmoS7RosbEO0MlsaNb+9aaQR9g=",
      "B1B800E199A6D4649287C11AE89F67CA:3udFXffIw3c7eM5hljF5mJQA36FbW2PeF8Gx1TcD1vc=",
      "D7727B4696A62373E9EBD9803F705B3C:XEbXIzCpOuA88jMBtt+XuMt+NaOIWlvfpW9h7i/dFlM=",
      "F07BE27DCEFDF52818EE7BA2CD9CA504:lc47A/VahaBWJLQY4V1YyjzJPI5xVErInDaqdwPjv2g=",
    ],
    unknownChunks: 1,
  },
  {
    build: "9.00",
    // chunk 1002 — BID_271_AssassinSuitMale, EID_AssassinSalute, EID_AssassinVest, Pickaxe_ID_213_AssassinSuitSledgehammer, Wrap_066_AssassinSuit02
    entries: [
      "EBFE6788D367D741AF0A4FD098CDFD39:FAeJTGyT49P+dQOmKx+lMYVAxu7qtIPlqSaLAR85zqI=",
    ],
    unknownChunks: 2,
  },
  {
    build: "9.01",
    // chunk 1001 — BID_271_AssassinSuitMale, EID_AssassinSalute, EID_AssassinVest, Pickaxe_ID_213_AssassinSuitSledgehammer, Wrap_066_AssassinSuit02
    entries: [
      "EBFE6788D367D741AF0A4FD098CDFD39:FAeJTGyT49P+dQOmKx+lMYVAxu7qtIPlqSaLAR85zqI=",
    ],
    unknownChunks: 1,
  },
  {
    build: "9.10",
    // chunk 1000 — BID_234_SpeedyMidnight, CID_371_Athena_Commando_M_SpeedyMidnight, Glider_ID_131_SpeedyMidnight, Pickaxe_ID_178_SpeedyMidnight
    // chunk 1001 — Glider_ID_150_TechOpsBlue
    // chunk 1002 — Trails_ID_059_Sony2
    // chunk 1003
    // chunk 1004 — CID_421_Athena_Commando_M_MaskedWarrior, CID_422_Athena_Commando_F_MaskedWarrior, Trails_ID_027_Sands, Wrap_070_MaskedWarrior
    // chunk 1006 — Monster Eye
    // chunk 1007
    // chunk 1008 — Doggo outfit body + set
    // chunk 1009
    entries: [
      "010E6ACF85E4A58BF6F551EFE7B85F61:DwCIH5Dw/1wdiS6gFGmWe4HUgD9kMOEzjbzM/1QshM4=",
      "1DF43E667862B117F72B5F39E750853A:Bhjx3mmVxhvadK5bkT+W9RJ0XAaMHawCnf8MfXIpABw=",
      "35DDA69DABF1DE5826348A3CCD0DFE5E:CfhL+/n+phBF7TV4Qpw4Qhqrd6g3S/Gq2sU5n0FiH6A=",
      "5332028CC33C98BF747EEF82B0384D8C:QxdEIZba2DLRx0jYKm8UpIk/K6eKuclfvDSTllMLLrk=",
      "54FD9ABD65879452DCB8CE11C1D7F1AF:nV0Vm4NCBl+MkGX8wiqfFrg0viDriL3I2xc4KS7n7fg=",
      "AB10C0F1C99E5A6E4E477300FBD5D170:tLrb56vTjn3uiZIRhHU+RYygmirLzGglmEdI4DqfK4M=",
      "AC424209DFAB55305097B2050E16E2E9:efXu+MoloNbSOOHz8X4ipvD2MhSMWpRCaEOVNcdLPrY=",
      "CBFF239A1792F25920D863F223368B54:J3N3cUH3M0R3uyzkE0qVK/SouxC/X6VEswcoWb6ViL8=",
      "F8D604C6FA9156F47356B54E1E442A97:EcmOKEqNv/9U+rw3oLZb7e+z4gaKWlfRIpdQwODvOKw=",
    ],
    unknownChunks: 1,
  },
  {
    build: "9.20",
    // chunk 1000
    // chunk 1001 — BID_234_SpeedyMidnight, CID_371_Athena_Commando_M_SpeedyMidnight, Glider_ID_131_SpeedyMidnight, Pickaxe_ID_178_SpeedyMidnight
    // chunk 1002
    // chunk 1003 — Synapse set
    // chunk 1004 — Glider_ID_150_TechOpsBlue
    // chunk 1005
    // chunk 1006 — Trails_ID_059_Sony2
    // chunk 1007
    // chunk 1009
    // chunk 1010 — Pickaxe_ID_221_SkullBriteEclipse
    // chunk 1011 — BID_284_NeonLines, CID_429_Athena_Commando_F_NeonLines
    // chunk 1013
    // chunk 1014 — Raging Storm set
    // chunk 1015 — Wrap_080_Blackout1
    // chunk 1016
    entries: [
      "001B8CDAE8386ACB5DFE26FA59C10B40:XA9kqeHyWLK/xsRzYLCkooN/dBRNTyjy5sw9Jv+8nRs=",
      "010E6ACF85E4A58BF6F551EFE7B85F61:DwCIH5Dw/1wdiS6gFGmWe4HUgD9kMOEzjbzM/1QshM4=",
      "03FBE2522823B14E3BD161BBCDAE4A85:kvHfxKURiw97DzzEt5xAUxVMFfxGya3Xw3kI7ORGEgM=",
      "134343D31031634B122471F73F611CBC:zqtMGKxH4+Ydcx+1mHOb5DIMYxctpm2nKqXp8c5hH/0=",
      "1DF43E667862B117F72B5F39E750853A:Bhjx3mmVxhvadK5bkT+W9RJ0XAaMHawCnf8MfXIpABw=",
      "340C0957F37B985956E74242A9487B5A:CiISJuNPymcbI3tJAxIaNfGCcHBr1ttSFr++4c5DQx0=",
      "35DDA69DABF1DE5826348A3CCD0DFE5E:CfhL+/n+phBF7TV4Qpw4Qhqrd6g3S/Gq2sU5n0FiH6A=",
      "3AC281E7A5EAA2765CFE02AC98B04FC8:R/hWNn8BcRRovJE/L7h15VDrJ0H4VqBBVt6XVvq2Ebw=",
      "6A3F6093DECACCD1F78CF802DE7AFF84:Skd0CfmqkmJAUqDFE6Qy/adL2MSN4IuAndXZ0SepEXw=",
      "82669F5A2F9B703D1A6BEA3BCB922D7D:Leu9rrDPaqZd3izIU+IKpFcP/NNcqSncLkV2lapQL6k=",
      "8A6DABC9AF8B5FE521D365DB605D0AE0:T721SqBTncYsd8Gej01RnLX6sEaCgJoILnRauHaJz+g=",
      "A6855B699FE10FE50301AFE1A4FA74CB:fKXFbKW6dUWHLSC8M4KLAg1elVXH+wYouFbpvvtiIcY=",
      "A7D34E80FA70CDD2F367DBEF93B98467:KVErbMXsQqx7dxrZp5Ara4OVlA17pc29E2SZlFNipPU=",
      "D85DFC0115FC3C75A6AD9C5D15B0DBF4:KFp5kuqdJIex+SS95mCy4nETnpzlaY8UHe8X7BSjGxY=",
      "F8D604C6FA9156F47356B54E1E442A97:EcmOKEqNv/9U+rw3oLZb7e+z4gaKWlfRIpdQwODvOKw=",
    ],
    unknownChunks: 2,
  },
  {
    build: "9.21",
    // chunk 1000
    // chunk 1001
    // chunk 1002 — Synapse set
    // chunk 1003 — Glider_ID_150_TechOpsBlue
    // chunk 1004
    // chunk 1005 — Trails_ID_059_Sony2
    // chunk 1006
    // chunk 1008
    // chunk 1009 — Pickaxe_ID_221_SkullBriteEclipse
    // chunk 1011
    // chunk 1012 — Wrap_080_Blackout1
    // chunk 1013
    entries: [
      "001B8CDAE8386ACB5DFE26FA59C10B40:XA9kqeHyWLK/xsRzYLCkooN/dBRNTyjy5sw9Jv+8nRs=",
      "03FBE2522823B14E3BD161BBCDAE4A85:kvHfxKURiw97DzzEt5xAUxVMFfxGya3Xw3kI7ORGEgM=",
      "134343D31031634B122471F73F611CBC:zqtMGKxH4+Ydcx+1mHOb5DIMYxctpm2nKqXp8c5hH/0=",
      "1DF43E667862B117F72B5F39E750853A:Bhjx3mmVxhvadK5bkT+W9RJ0XAaMHawCnf8MfXIpABw=",
      "340C0957F37B985956E74242A9487B5A:CiISJuNPymcbI3tJAxIaNfGCcHBr1ttSFr++4c5DQx0=",
      "35DDA69DABF1DE5826348A3CCD0DFE5E:CfhL+/n+phBF7TV4Qpw4Qhqrd6g3S/Gq2sU5n0FiH6A=",
      "3AC281E7A5EAA2765CFE02AC98B04FC8:R/hWNn8BcRRovJE/L7h15VDrJ0H4VqBBVt6XVvq2Ebw=",
      "6A3F6093DECACCD1F78CF802DE7AFF84:Skd0CfmqkmJAUqDFE6Qy/adL2MSN4IuAndXZ0SepEXw=",
      "82669F5A2F9B703D1A6BEA3BCB922D7D:Leu9rrDPaqZd3izIU+IKpFcP/NNcqSncLkV2lapQL6k=",
      "A6855B699FE10FE50301AFE1A4FA74CB:fKXFbKW6dUWHLSC8M4KLAg1elVXH+wYouFbpvvtiIcY=",
      "D85DFC0115FC3C75A6AD9C5D15B0DBF4:KFp5kuqdJIex+SS95mCy4nETnpzlaY8UHe8X7BSjGxY=",
      "F8D604C6FA9156F47356B54E1E442A97:EcmOKEqNv/9U+rw3oLZb7e+z4gaKWlfRIpdQwODvOKw=",
    ],
    unknownChunks: 2,
  },
  {
    build: "9.30",
    // chunk 1000
    // chunk 1001
    // chunk 1002
    // chunk 1003 — EID_SecurityGuard
    // chunk 1004 — Stranger Things set
    // chunk 1005 — BID_272_AssassinSuitFemale
    // chunk 1006 — EID_MakeItPlantain
    // chunk 1007
    // chunk 1008
    // chunk 1009 — Pickaxe_ID_193_HotDog
    // chunk 1010
    // chunk 1012
    // chunk 1013 — EID_CrabDance
    // chunk 1014 — EID_Shaka
    // chunk 1015 — Sizzlin' Emote
    // chunk 1016 — Pickaxe_ID_221_SkullBriteEclipse
    // chunk 1017
    // chunk 1018 — Hypermelon Wrap
    // chunk 1019
    // chunk 1020
    // chunk 1021 — Wrap_085_Beach
    // chunk 1022 — Wrap_084_4thofJuly
    // chunk 1023
    // chunk 1024 — Wrap_080_Blackout1
    // chunk 1025
    // chunk 1026 — Robot Arms
    // chunk 1027
    entries: [
      "001B8CDAE8386ACB5DFE26FA59C10B40:XA9kqeHyWLK/xsRzYLCkooN/dBRNTyjy5sw9Jv+8nRs=",
      "03FBE2522823B14E3BD161BBCDAE4A85:kvHfxKURiw97DzzEt5xAUxVMFfxGya3Xw3kI7ORGEgM=",
      "195439D6DD0FE44ADAE6BF7A44436519:kRCw7VFSPCYqhu7lJlA4kO4YmsqZUzxM6ARm7Ti8ntQ=",
      "210726DF9DCD78AD95B4D407D5D9157B:cXzvTrgNBBmsa8jR8E4q9NFBasv/zdQSSPQmnKznkJE=",
      "27D6556F776B2BDA97B480C1141DDDCA:uvUqb5LuwRFWQnA4oCRW3LNdorYcGtOmJ8PvBeCwBKg=",
      "2F2804FC81CA638FC3DFEE5FB922987B:vz4MvtMQubNdmH1BO2E2FnNT3/vSvjbIn7HWNcWIYl8=",
      "310CAA852300A8ED2B74754EF027C823:CbrsdQ2vpkgVe0Oc5HlGFLVkV9arQn928vHSnPpSxbk=",
      "3AC281E7A5EAA2765CFE02AC98B04FC8:R/hWNn8BcRRovJE/L7h15VDrJ0H4VqBBVt6XVvq2Ebw=",
      "3DFEA395156D835B86EB22801411ED08:cG8Q2VOqa9d+9J4QEvdBWe5hjbIayC4HtRp7svIWZ9g=",
      "41BDA9510489C841C335EBFA5E233CF0:NceSf4zJLAR1Clh17nKGtBrw62kDRE7tJrodbJYMbU0=",
      "4D896B93DC5B2D18AA2949EA7B67B4EA:0V70x6p0zRRV9bV6P+sq62lM0CdW4rvUgip6/65GWzc=",
      "5AEDD4DB5DA39071FCFC2404EEB3D02D:qaoe5DQrf1+HPEQRW5zls4KSe7DHbrxXO8OZMsFeo8Y=",
      "6B0D17A04F83AAF1E4EC1D0D481D7B03:fgSAnECppKmZD1eolFEZOuOpUDPbt1MmvGroMQ0sPFU=",
      "6DD6F574BA76BD6B68E14FF19181F2B6:Z/OnCtvolWJSaChHeIIVFXB8fptk8QBW8JQD1Gk2w+Y=",
      "7E9E6546A8C7109E9966F9C010D794A7:/hJU9SIxIewJ7taimArAwTbbuGG/4THrKvMElcTMzI0=",
      "82669F5A2F9B703D1A6BEA3BCB922D7D:Leu9rrDPaqZd3izIU+IKpFcP/NNcqSncLkV2lapQL6k=",
      "91DE2263000EF60E067F04C5505104C0:J72L3sJQnakH4GQrYgBz7QIAmI4aC1sde+iB7zErKG4=",
      "A6130F4077B928D41D298463C61C0F34:oW3GkVlIb8uiNl0CzqrwVZeGfnEujp2O3O3tnw2zFOs=",
      "A6855B699FE10FE50301AFE1A4FA74CB:fKXFbKW6dUWHLSC8M4KLAg1elVXH+wYouFbpvvtiIcY=",
      "AAB934D179F489B8084EB057031AB845:oJF2EGCXkWP7B1BVK8i4yJzvNtkwXozjZJZv7ZznEEA=",
      "B8C17AF9BC0DF3113AC6C498DF3325C2:iElxozD4UvK0+tPt0pPLg0gBoSkwLwByJiE4ucKHU7U=",
      "BB26302A83A2B42228EF6A731E598360:q6GH+OJutjEXL5wKuJnbLKAan9V/AXRxIkqg6WgSzUU=",
      "C015FB76A9E7912825A5F9CA69671961:4zfC1uF8ll4CkTBctitVmwjHsazAiz2LXPHIPj4ef98=",
      "D85DFC0115FC3C75A6AD9C5D15B0DBF4:KFp5kuqdJIex+SS95mCy4nETnpzlaY8UHe8X7BSjGxY=",
      "E4C183B0EF31ADF061F175068046568E:AF+fNwseLnjCsPKzbFkYDkZE4gyYfGEaifyJjdsMjp0=",
      "EBB742679C34C9D4E056A5EAADF325B9:ousld0RIkeu9L9aTDwr9aNCIt+wOwB7KxGPY9BTfQ7s=",
      "EE0C67580F774526D46A64757F5DE77E:qRq1DPp8GnsFZSUYR1PJKeKm5YXAg3Kyd5Y+pjtXZyU=",
    ],
    unknownChunks: 1,
  },
  {
    build: "9.40",
    // chunk 1000 — BID_289_Banner, CID_442_Athena_Commando_F_BannerA, CID_443_Athena_Commando_F_BannerB, CID_444_Athena_Commando_F_BannerC, CID_445_Athena_Commando_F_BannerD, CID_446_Athena_Commando_M_BannerA, CID_447_Athena_Commando_M_BannerB, CID_448_Athena_Commando_M_BannerC, CID_449_Athena_Commando_M_BannerD, Glider_ID_153_Banner, Pickaxe_ID_222_Banner
    // chunk 1001 — EID_MakeItPlantain
    // chunk 1003 — BID_311_Multibot, EID_TeamMonster, EID_TeamRobot
    // chunk 1004 — Monster vs Robot event
    // chunk 1005 — Pickaxe_ID_249_Squishy1H
    // chunk 1006 — EID_TrophyCelebration
    // chunk 1007 — CID_478_Athena_Commando_F_WorldCup, Wrap_102_WorldCup2019
    entries: [
      "22AB4BDC10065AA49B38DE88522DF836:1L8L+oKtSOtIxbm1x0HbDtzquIH6CH8vu1PF4i8jU+w=",
      "310CAA852300A8ED2B74754EF027C823:CbrsdQ2vpkgVe0Oc5HlGFLVkV9arQn928vHSnPpSxbk=",
      "5E15C5486CE8E539552D4D3E7682F9E2:+L/tTz+woDFZJEvtxfq8m8tNI1R72sYK7rnYr7sHTis=",
      "79F7D9C856E8CF354109D3298F076C06:Ak3TOM0i0Mq/KYxd7SDlSuS7o55USaf+urL6WqnmalY=",
      "AEC9FD29ACF48B274A1A573C9ECF4B06:7OT+zOUDq1RjYJKp8gQhbUnYz/qJ19It2X4HduP5y/g=",
      "B7D9219AF6290146AAFF711E464C5849:iwGv47bJtl/Tm8oJGdnta9aDA86nY0IyjDmJWjQYdQo=",
      "DC487286E8C1CD5FE18AC3FE76034EF2:3h9IwK2qQP8PHVuO1aZI1C34JrJxKBnXJOFcSDSj99M=",
    ],
    unknownChunks: 1,
  },
  {
    build: "9.41",
    // chunk 1000 — EID_MakeItPlantain
    // chunk 1002 — Monster vs Robot event
    // chunk 1003 — Pickaxe_ID_249_Squishy1H
    // chunk 1004 — EID_TrophyCelebration
    // chunk 1005 — CID_478_Athena_Commando_F_WorldCup, Wrap_102_WorldCup2019
    entries: [
      "310CAA852300A8ED2B74754EF027C823:CbrsdQ2vpkgVe0Oc5HlGFLVkV9arQn928vHSnPpSxbk=",
      "79F7D9C856E8CF354109D3298F076C06:Ak3TOM0i0Mq/KYxd7SDlSuS7o55USaf+urL6WqnmalY=",
      "AEC9FD29ACF48B274A1A573C9ECF4B06:7OT+zOUDq1RjYJKp8gQhbUnYz/qJ19It2X4HduP5y/g=",
      "B7D9219AF6290146AAFF711E464C5849:iwGv47bJtl/Tm8oJGdnta9aDA86nY0IyjDmJWjQYdQo=",
      "DC487286E8C1CD5FE18AC3FE76034EF2:3h9IwK2qQP8PHVuO1aZI1C34JrJxKBnXJOFcSDSj99M=",
    ],
    unknownChunks: 1,
  },
  {
    build: "10.0",
    // chunk 1001
    // chunk 1002 — Monster vs Robot event
    // chunk 1003 — BID_328_WildWest, BID_329_WildWestFemale, Pickaxe_ID_114_BadassCowboyCowSkull
    entries: [
      "6838E4BB35C0449D4F66F7E92A960D1F:KOKH3JA+OMliB+f17Pd8OFEtooaCZjehz3CvfqaSbtU=",
      "79F7D9C856E8CF354109D3298F076C06:Ak3TOM0i0Mq/KYxd7SDlSuS7o55USaf+urL6WqnmalY=",
      "E3D0A604B93651DDC6779B14F21D0FDA:8gPR3gZwEJxfkZBkXk0QAlpnJ7q5mXzVc0DN3lzpJ5k=",
    ],
    unknownChunks: 1,
  },
  {
    build: "10.10",
    // chunk 1000 — Star Walker set
    // chunk 1001
    // chunk 1003
    // chunk 1004 — Major Lazer
    // chunk 1005 — BID_330_AstronautEvilUpgrade, Wrap_118_AstronautEvil
    // chunk 1006
    // chunk 1007 — Some of the Leftovers set
    entries: [
      "32F8552040D83320E998654666873931:izPPgPIvrxfBXPaI/LJzO5lxOZtzjOXQJBuk9kPdKe0=",
      "504BC0A80EE72DFEEF9CB7EE3FFCE163:eToIGihi0lTVTcHietksl1e6cHBf5h30aYO5YXpWXY4=",
      "6838E4BB35C0449D4F66F7E92A960D1F:KOKH3JA+OMliB+f17Pd8OFEtooaCZjehz3CvfqaSbtU=",
      "73FDB8F2BDCCF4518225CB3E28DD9C0A:MBo/DO8mLebMquZPCgeE/FgUdJOXASKVjIJ1H+IEPac=",
      "7A8E25F664219ED6CCF3AB1658D0E557:TV+yyWpI3iHJoaK3o1t6+/uhN/sFZ1OixoAx0n7MtjM=",
      "80FC6D214CD513415CB0A54044683293:fXY1Xojrg1HpH6ZF0xNrhF9XZKS15GmaBidF9kSAbME=",
      "8DCAE39C7D9690E19F52655F02C613B2:ZZHbiVsbXquLlrtNVHtryLS3Vd1Ego8/8tlDpeUCgfc=",
    ],
    unknownChunks: 1,
  },
  {
    build: "10.30",
    // chunk 1000
    // chunk 1001 — EID_SpeedRun
    // chunk 1003
    // chunk 1004
    // chunk 1006 — EID_AlienSupport, Pickaxe_ID_275_Traveler
    // chunk 1007
    // chunk 1008
    // chunk 1009
    // chunk 1011
    // chunk 1012
    // chunk 1013
    // chunk 1015
    // chunk 1016
    entries: [
      "2CEE3C1783B9E41EB66238BAD32EFF23:udlTL9abg8LIGytWpERMGVEpPrj9io23R2HbINHtF3o=",
      "2FF619685EC983B800018ECBFF377ABB:Dn5ZlXEhBAhXP0RbkDskEQwOK4RUKTwAIls6cvVOr0g=",
      "4C546A04EB0E91B7EB4449B672B63900:RhtdrUqq3N21E77X7YatI4oX3wLYyvFH5Wm+eaUX8+w=",
      "504BC0A80EE72DFEEF9CB7EE3FFCE163:eToIGihi0lTVTcHietksl1e6cHBf5h30aYO5YXpWXY4=",
      "5C0BC5E8819B8968CF25C60885F0CB5E:E52Ld2gtMzMFUMkdMpjNWmEHEgr1qnH+iliH2ha27dQ=",
      "65000C27C3BC5B9B904A0D20050D6B36:JFwQi7tWgJDr+E4GzYU/rgasjjk+1BKRB/N88e7rVvI=",
      "80FC6D214CD513415CB0A54044683293:fXY1Xojrg1HpH6ZF0xNrhF9XZKS15GmaBidF9kSAbME=",
      "8AE56A5795250C959CD4357AF32DA563:GL9+gTLkh5vnyzImLDdxGYFksrHsmmJSUfZB9mP9fdM=",
      "B8F307A56B6EEFACD6250B2E60A24A4C:ayYSM667dKzMIvm8ZUY0F+FNlvNsg4G2RMIgi2fPf8k=",
      "B9E5ABB4D4F783F13E7A32B971597F03:HGWfy8LBJu12s5HZeYTZDqP2EI3dJqPXupxd2AzYdUI=",
      "C5188047D9661347FC4483CCB04ACD4C:TlesZ5LgoEoJqkJaz7N2QB43zNWIJdOpx8rOpsbGC48=",
      "E04FBD38CB934DB1363EF57C85E48F9F:E+/j7zhGIdHODfCdH2vh4rgGRYSssFpT/s6dlus9Csc=",
      "E4143E437DE7481237AFAB40C59D96E6:a35NCp3zTY2AhSsZWy09BJaXJDU0LMJbiiP1u0dOl0Q=",
    ],
    unknownChunks: 4,
  },
  {
    build: "10.31",
    // chunk 1000 — EID_SpeedRun
    // chunk 1002
    // chunk 1004 — EID_AlienSupport, Pickaxe_ID_275_Traveler
    // chunk 1005
    // chunk 1007 — BID_361_BlackMondayFemale_R0P2N, EID_BlackMondayFemale_6HO4L, EID_BlackMondayMale_E0VSB, Glider_ID_176_BlackMondayCape_4P79K, MusicPack_030_BlackMonday_X91ZH, Pickaxe_ID_276_BlackMondayFemale1H_1V4HE
    // chunk 1008
    // chunk 1010
    // chunk 1011
    entries: [
      "2FF619685EC983B800018ECBFF377ABB:Dn5ZlXEhBAhXP0RbkDskEQwOK4RUKTwAIls6cvVOr0g=",
      "464F39FB64FAF4AB6843449EDD0BE3BE:0yYMEXLHteghUwUW+SThzKXltdNzvA42CssFpAXgxFA=",
      "5C0BC5E8819B8968CF25C60885F0CB5E:E52Ld2gtMzMFUMkdMpjNWmEHEgr1qnH+iliH2ha27dQ=",
      "8AE56A5795250C959CD4357AF32DA563:GL9+gTLkh5vnyzImLDdxGYFksrHsmmJSUfZB9mP9fdM=",
      "BA6DF4F82C5CAB3CE1C51156BFCACE71:SDOlhnlP1SENGT+SrYUqeGIz0TkgoM7dQjfmfxegb1o=",
      "C5188047D9661347FC4483CCB04ACD4C:TlesZ5LgoEoJqkJaz7N2QB43zNWIJdOpx8rOpsbGC48=",
      "E4143E437DE7481237AFAB40C59D96E6:a35NCp3zTY2AhSsZWy09BJaXJDU0LMJbiiP1u0dOl0Q=",
      "F707FA321C9644351C5F87893C16580F:bOW0W1Al3NZZGbPupvIlLl7wWgBA2jPtH6SZO/fjdy0=",
    ],
    unknownChunks: 4,
  },
  {
    build: "11.01",
    // chunk 1000 — BID_207_DumplingMan, Pickaxe_ID_157_Dumpling
    // chunk 1001
    // chunk 1002 — Pickaxe_ID_297_FlowerSkeletonFemale1H
    // chunk 1003
    // chunk 1004
    // chunk 1005
    // chunk 1006
    entries: [
      "17F31F416B1B0A73F14F0A7973DDBD76:+hUk8/wD736u5sylQPXcKKREoo5vSPaWPG+3xxT5nFM=",
      "280F643808DE5EAB39E77B23E2193CE9:lYbsbCLMwjFvdalNxsBUj+PZiJmtoa/wclz2sAOQxuM=",
      "2FE8DBD09F14AAF7D195AA73B9613792:KwIehLEKaCSJb5X/WcQ9IULKkz3G3M9f9Z5Jgi9hYUU=",
      "3D8D56FDB72DACCA7E656FBC0F125916:gMX76nmLV2caz28Ro/i3FatCU4tdi1jHgJSPbdnLTUc=",
      "5581F333809DD14FA591F17B6C071687:/gEEJhUVQMVyFP7JR0jT4RM99Wj7hnIp2ZitAVdwAYc=",
      "975414A2AAC78A3710C3A47A8E3B7A57:LQWa9K05LB13Fn7Brzi8R3vsMRmFcNyJaoAcmBFZNjg=",
      "D1EBFA5EEFFAFC07E39EE2D9986CF8FB:jdM2xx6liOm1miOSVC7txNj6HvWF7/zCq4zxMYFYxug=",
    ],
    unknownChunks: 0,
  },
  {
    build: "11.11",
    // chunk 1000 — BID_207_DumplingMan, Pickaxe_ID_157_Dumpling
    // chunk 1001 — Trails_ID_081_MissingLink
    // chunk 1002
    // chunk 1003
    entries: [
      "17F31F416B1B0A73F14F0A7973DDBD76:+hUk8/wD736u5sylQPXcKKREoo5vSPaWPG+3xxT5nFM=",
      "1A10A7700C3780E2B1A03037D64E1EE5:IvQikWqraVuMzt8eP1B0cxW5Dcaiv7njo2QHFfZFmY8=",
      "5869B4D27CF6766E4047DB0636CB6D72:bFnq5n5S+PRZZFp/dGhAmy63liDVz7wufMqMm65B0FE=",
      "C348806ECD35F176A5C50306B0A07DB9:x8+m/v+Cn55R+CIZrsqqSKxa5JpkQyQGeLVTJ8evrpw=",
    ],
    unknownChunks: 0,
  },
  {
    build: "11.20",
    // chunk 1000 — BID_421_TeriyakiWarrior, Wrap_176_TeriyakiWarrior
    // chunk 1001 — BID_207_DumplingMan, Pickaxe_ID_157_Dumpling
    entries: [
      "06B9F77E165673FD1C5FF5099F43D1F3:Bvw6h4GKOLjC/wFgHQsiLePbBZhtPiNhtr5keDBse70=",
      "17F31F416B1B0A73F14F0A7973DDBD76:+hUk8/wD736u5sylQPXcKKREoo5vSPaWPG+3xxT5nFM=",
    ],
    unknownChunks: 0,
  },
  {
    build: "11.21",
    // chunk 1000 — BID_207_DumplingMan, Pickaxe_ID_157_Dumpling
    // chunk 1001
    entries: [
      "17F31F416B1B0A73F14F0A7973DDBD76:+hUk8/wD736u5sylQPXcKKREoo5vSPaWPG+3xxT5nFM=",
      "36126C339CEBD31F23562CDCC5DFDD4D:cuLUN7oD/p5BSxuk6pKGY6KtlhGInVti36sV6zSv1n4=",
    ],
    unknownChunks: 0,
  },
  {
    build: "11.30",
    // chunk 1000 — Star Wars event
    // chunk 1001 — BID_426_GalileoKayak_NS67T
    // chunk 1002 — BID_207_DumplingMan, Pickaxe_ID_157_Dumpling
    // chunk 1003 — Star Wars event
    // chunk 1004 — BID_423_HolidayTime, Pickaxe_ID_330_HolidayTimeMale, Wrap_180_HolidayTime
    // chunk 1005 — BID_427_GalileoSled_ZDWOV, BID_428_GalileoFerry_28UZ3, BID_429_GalileoRocket_ZD0AF, BannerToken_015_GalileoA_0W6VH, BannerToken_018_GalileoD_5XXFQ, EID_Galileo1_B3EX6, EID_Galileo2_2VYEJ, EID_Galileo4_PXPE0, Glider_ID_186_GalileoFerry_48L4V, Pickaxe_ID_326_GalileoFerry1H_F5IUA, Pickaxe_ID_328_GalileoRocket_SNC0L
    // chunk 1006 — BID_441_HolidayPJ, CID_649_Athena_Commando_F_HolidayPJ, CID_650_Athena_Commando_F_HolidayPJ_B, CID_651_Athena_Commando_F_HolidayPJ_C, CID_652_Athena_Commando_F_HolidayPJ_D, Wrap_179_HolidayPJs
    // chunk 1007 — Pickaxe_ID_327_GalileoKayak_50NFG
    // chunk 1008 — BID_446_Barefoot
    // chunk 1010
    // chunk 1012
    // chunk 1015
    // chunk 1016 — CID_632_Athena_Commando_F_GalileoZeppelin_SJKPW, Glider_ID_189_GalileoZeppelinFemale_353IC
    // chunk 1018 — Star Wars event
    // chunk 1020 — Star Wars event
    entries: [
      "0C2DFF3432352A23684E05B0794DFFC7:FG55cmgdBnszsr5pS0aBC44NVl7OyI+AuOXxALyaNKA=",
      "13F1DD5EC796B357B6085D50BBDA3C18:7NRW9FQONfoNEwOJARayC1upKkjg3obxAWICvcXfUWs=",
      "17F31F416B1B0A73F14F0A7973DDBD76:+hUk8/wD736u5sylQPXcKKREoo5vSPaWPG+3xxT5nFM=",
      "37B3D2284CB3924E6592C2D1D11451E4:CMJclyQ1I9iY+VkDiajhGxxYQmZGHrTAlEl/wtlT+pk=",
      "5738A14C7E45E1B405CEF920829CB255:xZHlPTz/dxNahrp9IqTZ+tjOZSYMxQb9KZFXlg9N638=",
      "57EC154062C75464BD8A087D89732317:5AEwoCp79njYci8QYF+sLMkGpjDnFCYLSCtz4LD9D78=",
      "5D6562F1EAD89513C82C2F37A24E7F82:I2c+SQCdDvJpC6z1xniRT+k41KAp0pla+o/H68oXFLQ=",
      "6BE73A630C01192C39807CEDA006C77C:3MYDxjacnNgSQwxc68DknO3e6TKXSw4tG5TVdSxGdFE=",
      "715D5B8D89F01C804C2ED33648157A6C:GbMcQmdpv3ju/P36UQIlDFZ0Q5jr0he7O2oTJ702McY=",
      "8033BA4F3E1FB68ABADE271C9BE4EE42:XGwA8RWdavpeScQpqM/aFod3SGTB3PibdGE7iGKR4jg=",
      "A02E08C8CE48D4D8676358FF7BE55533:d9wA4snpl4I4B4zZFxWyu9cL9zSkXqy9+vTw9PUhHlw=",
      "C1C31115267D6802AD699472D2621F25:zAyelFy6RcyGIW/9z9IvgEbmRW9pdAytvgBIPb1/kdk=",
      "D47DF51158673BE6CD4D32E84C91DF7F:+EzQK4ojNk1DqxceQeArAGZhQPQyuQBKX4gVuGEqSxM=",
      "F71D60AE5231E90CEA7F53D90DC4F007:ver8B06IS0up7tNYy03zkhCl+CrTl3czgmXPYYONcM8=",
      "FBAC0AD8C03AAB2DC3BC077597517179:5oj8B4R53plPxRictMN6QkQ741CibMbmzRJYIDIQ5iM=",
    ],
    unknownChunks: 6,
  },
  {
    build: "11.31",
    // chunk 1000 — Star Wars event
    // chunk 1001 — BID_426_GalileoKayak_NS67T
    // chunk 1002 — BID_207_DumplingMan, Pickaxe_ID_157_Dumpling
    // chunk 1003 — Star Wars event
    // chunk 1004 — BID_423_HolidayTime, Pickaxe_ID_330_HolidayTimeMale, Wrap_180_HolidayTime
    // chunk 1005 — BID_427_GalileoSled_ZDWOV, BID_428_GalileoFerry_28UZ3, BID_429_GalileoRocket_ZD0AF, BannerToken_015_GalileoA_0W6VH, BannerToken_018_GalileoD_5XXFQ, EID_Galileo1_B3EX6, EID_Galileo2_2VYEJ, EID_Galileo4_PXPE0, Glider_ID_186_GalileoFerry_48L4V, Pickaxe_ID_326_GalileoFerry1H_F5IUA, Pickaxe_ID_328_GalileoRocket_SNC0L
    // chunk 1006 — BID_441_HolidayPJ, CID_649_Athena_Commando_F_HolidayPJ, CID_650_Athena_Commando_F_HolidayPJ_B, CID_651_Athena_Commando_F_HolidayPJ_C, CID_652_Athena_Commando_F_HolidayPJ_D, Wrap_179_HolidayPJs
    // chunk 1007 — BID_446_Barefoot
    // chunk 1009
    // chunk 1011
    // chunk 1014
    // chunk 1015 — CID_632_Athena_Commando_F_GalileoZeppelin_SJKPW, Glider_ID_189_GalileoZeppelinFemale_353IC
    // chunk 1016 — Star Wars event
    // chunk 1018 — Star Wars event
    entries: [
      "0C2DFF3432352A23684E05B0794DFFC7:FG55cmgdBnszsr5pS0aBC44NVl7OyI+AuOXxALyaNKA=",
      "13F1DD5EC796B357B6085D50BBDA3C18:7NRW9FQONfoNEwOJARayC1upKkjg3obxAWICvcXfUWs=",
      "17F31F416B1B0A73F14F0A7973DDBD76:+hUk8/wD736u5sylQPXcKKREoo5vSPaWPG+3xxT5nFM=",
      "37B3D2284CB3924E6592C2D1D11451E4:CMJclyQ1I9iY+VkDiajhGxxYQmZGHrTAlEl/wtlT+pk=",
      "5738A14C7E45E1B405CEF920829CB255:xZHlPTz/dxNahrp9IqTZ+tjOZSYMxQb9KZFXlg9N638=",
      "57EC154062C75464BD8A087D89732317:5AEwoCp79njYci8QYF+sLMkGpjDnFCYLSCtz4LD9D78=",
      "5D6562F1EAD89513C82C2F37A24E7F82:I2c+SQCdDvJpC6z1xniRT+k41KAp0pla+o/H68oXFLQ=",
      "715D5B8D89F01C804C2ED33648157A6C:GbMcQmdpv3ju/P36UQIlDFZ0Q5jr0he7O2oTJ702McY=",
      "8033BA4F3E1FB68ABADE271C9BE4EE42:XGwA8RWdavpeScQpqM/aFod3SGTB3PibdGE7iGKR4jg=",
      "A02E08C8CE48D4D8676358FF7BE55533:d9wA4snpl4I4B4zZFxWyu9cL9zSkXqy9+vTw9PUhHlw=",
      "C1C31115267D6802AD699472D2621F25:zAyelFy6RcyGIW/9z9IvgEbmRW9pdAytvgBIPb1/kdk=",
      "D47DF51158673BE6CD4D32E84C91DF7F:+EzQK4ojNk1DqxceQeArAGZhQPQyuQBKX4gVuGEqSxM=",
      "F71D60AE5231E90CEA7F53D90DC4F007:ver8B06IS0up7tNYy03zkhCl+CrTl3czgmXPYYONcM8=",
      "FBAC0AD8C03AAB2DC3BC077597517179:5oj8B4R53plPxRictMN6QkQ741CibMbmzRJYIDIQ5iM=",
    ],
    unknownChunks: 5,
  },
  {
    build: "11.50",
    // chunk 1000 — EID_NeverGonna
    entries: [
      "2E539CD42E0594ED4D217ABE4E2B616F:9zdoLMrIZomTGmvDId1RMEGSfktV9gBGgcD2diSSMw4=",
    ],
    unknownChunks: 0,
  },
  {
    build: "12.00",
    // chunk 1000
    // chunk 1001
    entries: [
      "E36F7DC3B2ECE987FC956C3CF7E71F21:+Y1iPDRR7adeEjebuo6DzBiHkgK0c4ZOwgmrnYYx43w=",
      "E7C565B86445735863B8080B9BE651F7:7M3P/+is0y8muF7/0N2dJo96J3P/k991Vast/lb7Xec=",
    ],
    unknownChunks: 0,
  },
  {
    build: "12.10",
    // chunk 1000 — BID_488_LuckyHero, CID_718_Athena_Commando_F_LuckyHero
    // chunk 1001 — BID_494_StreetFashionEmerald, Pickaxe_ID_372_StreetFashionEmeraldFemale1H
    // chunk 1002
    // chunk 1003
    entries: [
      "110D116208C62834812C2EDF2F305E49:MwuF5zX7GpQCGL2w+CwkPmGzH3q05YUoLo5udhVMNPg=",
      "498A4AB4BC3BFA9B055CDBE833C51670:67ndB88hm7gomLYiklekB5rGWrcr8RJ6K+no9DTP87M=",
      "E36F7DC3B2ECE987FC956C3CF7E71F21:+Y1iPDRR7adeEjebuo6DzBiHkgK0c4ZOwgmrnYYx43w=",
      "E7C565B86445735863B8080B9BE651F7:7M3P/+is0y8muF7/0N2dJo96J3P/k991Vast/lb7Xec=",
    ],
    unknownChunks: 0,
  },
  {
    build: "12.20",
    // chunk 1000 — BID_488_LuckyHero, CID_718_Athena_Commando_F_LuckyHero
    // chunk 1002 — BID_494_StreetFashionEmerald, Pickaxe_ID_372_StreetFashionEmeraldFemale1H
    // chunk 1003
    // chunk 1004
    entries: [
      "110D116208C62834812C2EDF2F305E49:MwuF5zX7GpQCGL2w+CwkPmGzH3q05YUoLo5udhVMNPg=",
      "498A4AB4BC3BFA9B055CDBE833C51670:67ndB88hm7gomLYiklekB5rGWrcr8RJ6K+no9DTP87M=",
      "E36F7DC3B2ECE987FC956C3CF7E71F21:+Y1iPDRR7adeEjebuo6DzBiHkgK0c4ZOwgmrnYYx43w=",
      "E7C565B86445735863B8080B9BE651F7:7M3P/+is0y8muF7/0N2dJo96J3P/k991Vast/lb7Xec=",
    ],
    unknownChunks: 1,
  },
  {
    build: "12.21",
    // chunk 1000
    // chunk 1001
    entries: [
      "E36F7DC3B2ECE987FC956C3CF7E71F21:+Y1iPDRR7adeEjebuo6DzBiHkgK0c4ZOwgmrnYYx43w=",
      "E7C565B86445735863B8080B9BE651F7:7M3P/+is0y8muF7/0N2dJo96J3P/k991Vast/lb7Xec=",
    ],
    unknownChunks: 0,
  },
  {
    build: "12.40",
    // chunk 1000
    // chunk 1001
    // chunk 1002
    // chunk 1003
    // chunk 1004
    // chunk 1005
    entries: [
      "46159C748694298198A52DC07476FDA3:4CLHOBqSrmS1RkG/SxZYi8Rc0zCmAKxXIBMMUHDl2ag=",
      "63B2E664F9DEE5B42299191174C3B3C3:U1GOSBqPUDAFq3pjEdJg8nHb321IH6571dkhF0nEMss=",
      "9078B5331B187C32C649D4B1E5530EEC:l1U0jw2fdShRIHGNl1NYmG8YDAJEUSIfhI46nJgSt30=",
      "B77D921A94CDDAA841609065AE4C7BC0:SLDMLjxWpK+h1P4WNnqlixpWwujuV8OUZw+NoufV7sA=",
      "E36F7DC3B2ECE987FC956C3CF7E71F21:+Y1iPDRR7adeEjebuo6DzBiHkgK0c4ZOwgmrnYYx43w=",
      "E7C565B86445735863B8080B9BE651F7:7M3P/+is0y8muF7/0N2dJo96J3P/k991Vast/lb7Xec=",
    ],
    unknownChunks: 0,
  },
  {
    build: "12.41",
    // chunk 1000 — Astronomical event
    entries: [
      "8734362B2A2A8B0FBC9EDE6160627E1D:8ZsoLeTeezxjoIxnNfUrNf61XfqMEKfnyTb3u4o/X6g=",
    ],
    unknownChunks: 0,
  },
  {
    build: "12.60",
    // chunk 1000
    // chunk 1001
    // chunk 1002 — BID_527_Loofah, EID_Loofah, Pickaxe_ID_399_LoofahFemale1H
    entries: [
      "1AFD764881D1E33FDAA65707010712AD:cbKyY3ux6wrdiWz2dXJq18KJaAYmUgBZ2aZsfz1UE3M=",
      "2F1A5AFD22512A8B16494629CCA065B2:Un44BCuGtirrKab0E9TeOyDRnWC/Jh1h48+FOn4UrtA=",
      "3AC8A6B5089F55E17E00AAD8AC3C6406:TlUSkJe3y85fW83rHMy+XuqcZxQduXcB8yftpPoiDvo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "12.61",
    // chunk 1000 — BID_527_Loofah, EID_Loofah, Pickaxe_ID_399_LoofahFemale1H
    // chunk 1001
    // chunk 1002
    // chunk 1003
    // chunk 1004 — Fungus King set
    // chunk 1005 — The Device (Doomsday) event
    entries: [
      "3AC8A6B5089F55E17E00AAD8AC3C6406:TlUSkJe3y85fW83rHMy+XuqcZxQduXcB8yftpPoiDvo=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "91181AD6BCB9443F7F6479DA8BA9B7A4:ckv0KEQuDpca5cP5JLUH8K1f+tVYvZptoMsGYR7fxDU=",
      "BB59BEF60B72A241855EEC0FD63154D9:ZAQI6o6tkjRB6mh7VwOsf0x9DGyEAbGZ8qlUxS1fVm4=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "F51C8301B1C9BE9D4C4F48ED2C0FE067:+MsgNTH4cF1Mr4mjNVZVgsf3GBgjSjYn2yRZn2fE70A=",
    ],
    unknownChunks: 0,
  },
  {
    build: "13.20",
    // chunk 1000 — BID_545_RenegadeRaiderFire
    // chunk 1001
    // chunk 1002
    // chunk 1003 — BID_553_Seaweed_NIS9V, Pickaxe_ID_427_Seaweed1H_CZ9HA
    // chunk 1004 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1005
    // chunk 1006
    // chunk 1007
    // chunk 1009
    // chunk 1010
    // chunk 1011 — EID_Fireworks_WKX2W, Pickaxe_ID_420_CandyAppleSour_JXBZA
    // chunk 1012 — Fungus King set
    // chunk 1013
    entries: [
      "02421097082555483CA9524F79EF7687:e9wZT5/2KHmpbw6KjR8u4uo3iG00O92+PAZMbk09a3w=",
      "0CAB99F6E84D4E4C616B895E243F3B67:DWU31IKjnLsEt8sBBDfWQ3DPbZzpJ2JmfbxYdQ8QPZI=",
      "1D02A6E14FDF53655E818CEF9E57B1BF:ekG/6DFEYOaCYi5hruGoY/o1KzC/O5+9hJbdMyti8Gk=",
      "2D24182706636A7BD3E96AD37605BAD6:jEZJE+EAU7VDo6p6Y84e4+p3AHxYBWin144H4MhzaSQ=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "545BD59335CA43AC4481A621226B4E81:4lYAxO0wSzKarpiMl4b+bWQOjDkXdJKactoCetH65WY=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "7ADE21079D27D9CA3931F676358A0F72:jWtbxcYHNph24P0SKVvPEuGDIdFpq+wZAEIlGXhSpj4=",
      "8B9DC1A32A4081596F0AE60926CF6846:4O/n/4TAJpnQ3BvcadiKLHRNSmZQQbr+15RSrDHnrQ4=",
      "925BD833E71FF05FB73136BF57189C5C:WsXZpM/1+PT+xzorL685J5XB1dpvv8IOpOeeA2Rl1zE=",
      "B66EED5CA4F4ED75170872E30B9B0E23:rHT8/uzcZZ0ENxU9dxKpr+cdAajZ5L5U0geHt6NoZhI=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CBAC886CCED55EEAEDC0D4BED9588035:+5bLkb9JJIJBPrVxzvfhb0CkKU4ITf8SJRRG14UzyfI=",
    ],
    unknownChunks: 1,
  },
  {
    build: "13.30",
    // chunk 1000
    // chunk 1001
    // chunk 1002 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1003
    // chunk 1004
    // chunk 1005
    // chunk 1006
    // chunk 1007 — CID_719_Athena_Commando_F_Blonde
    // chunk 1008
    // chunk 1009
    // chunk 1010 — BID_566_TeriyakiAtlantis, Pickaxe_ID_435_TeriyakiAtlantisMale1H
    // chunk 1011 — Fungus King set
    // chunk 1012
    entries: [
      "0CAB99F6E84D4E4C616B895E243F3B67:DWU31IKjnLsEt8sBBDfWQ3DPbZzpJ2JmfbxYdQ8QPZI=",
      "1D02A6E14FDF53655E818CEF9E57B1BF:ekG/6DFEYOaCYi5hruGoY/o1KzC/O5+9hJbdMyti8Gk=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "545BD59335CA43AC4481A621226B4E81:4lYAxO0wSzKarpiMl4b+bWQOjDkXdJKactoCetH65WY=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "5A33986E8C23E664BD8A70D41697A93F:nFqFG2z7mnQhf4Q3iR6zQ2eWykiuwy0af+ga9QWnU6o=",
      "7ADE21079D27D9CA3931F676358A0F72:jWtbxcYHNph24P0SKVvPEuGDIdFpq+wZAEIlGXhSpj4=",
      "819F658DBDBB5D333430800891F28361:u/+kuv6DsiUouUOusRRfC8Ti5rCKhsgIyxyOnLH3Mh0=",
      "8B9DC1A32A4081596F0AE60926CF6846:4O/n/4TAJpnQ3BvcadiKLHRNSmZQQbr+15RSrDHnrQ4=",
      "925BD833E71FF05FB73136BF57189C5C:WsXZpM/1+PT+xzorL685J5XB1dpvv8IOpOeeA2Rl1zE=",
      "A25DFB2C9EBAECE22F893DAA48A7138F:d5KZse0g/v9xySiDWLhNw3kCvlWXZKWMKUjDzW8/SIg=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CBAC886CCED55EEAEDC0D4BED9588035:+5bLkb9JJIJBPrVxzvfhb0CkKU4ITf8SJRRG14UzyfI=",
    ],
    unknownChunks: 0,
  },
  {
    build: "13.40",
    // chunk 1000
    // chunk 1001
    // chunk 1002
    // chunk 1003 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1004
    // chunk 1005
    // chunk 1006
    // chunk 1007
    // chunk 1008
    // chunk 1009 — CID_719_Athena_Commando_F_Blonde
    // chunk 1010
    // chunk 1011
    // chunk 1012
    // chunk 1013 — Fungus King set
    // chunk 1014
    entries: [
      "0CAB99F6E84D4E4C616B895E243F3B67:DWU31IKjnLsEt8sBBDfWQ3DPbZzpJ2JmfbxYdQ8QPZI=",
      "1D02A6E14FDF53655E818CEF9E57B1BF:ekG/6DFEYOaCYi5hruGoY/o1KzC/O5+9hJbdMyti8Gk=",
      "258D945630DF6E1016889F47B16EED80:zQ/4osJ36W0V1DFXswf8JSStDMBTZPQ8oFcMrDqS7BM=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "3DB93E023E700ACD0C78072ED4787D37:aePdzcjsQvnpefA3P/cKfnZrVspZ5QVSsAc+Rui20pM=",
      "545BD59335CA43AC4481A621226B4E81:4lYAxO0wSzKarpiMl4b+bWQOjDkXdJKactoCetH65WY=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "5A33986E8C23E664BD8A70D41697A93F:nFqFG2z7mnQhf4Q3iR6zQ2eWykiuwy0af+ga9QWnU6o=",
      "7ADE21079D27D9CA3931F676358A0F72:jWtbxcYHNph24P0SKVvPEuGDIdFpq+wZAEIlGXhSpj4=",
      "819F658DBDBB5D333430800891F28361:u/+kuv6DsiUouUOusRRfC8Ti5rCKhsgIyxyOnLH3Mh0=",
      "8B9DC1A32A4081596F0AE60926CF6846:4O/n/4TAJpnQ3BvcadiKLHRNSmZQQbr+15RSrDHnrQ4=",
      "925BD833E71FF05FB73136BF57189C5C:WsXZpM/1+PT+xzorL685J5XB1dpvv8IOpOeeA2Rl1zE=",
      "B16BF216C9085E63B70056FF0459F87A:xKQqQkkw6VWwT0pk7eKzepG9HM9kzi2ZPwSbdLWtpwI=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CBAC886CCED55EEAEDC0D4BED9588035:+5bLkb9JJIJBPrVxzvfhb0CkKU4ITf8SJRRG14UzyfI=",
    ],
    unknownChunks: 0,
  },
  {
    build: "14.00",
    // chunk 1000
    // chunk 1001
    // chunk 1002 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1003
    // chunk 1004 — BID_605_Soy_Y0DW7, Glider_ID_238_Soy_RWO5D, Pickaxe_ID_462_Soy_4CW52
    // chunk 1005 — CID_719_Athena_Commando_F_Blonde
    // chunk 1006
    // chunk 1007
    // chunk 1008 — Fungus King set
    entries: [
      "0CD312F730BA9C3FD6CD67420EDDACF7:nXBDxcWYx2VtjMeRCDfSak9+f9aSOgrcxp8GKeUiId4=",
      "276E65E4041C467319534B14EAEA338A:Ib7KJMP8Q9if+P6x2bYZ0dC538B4LL3J1TcIy3rBlHk=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "59AF6C46ABB214024067564F69D6EA37:NtUgzeFVvkbyZQGRVdteWV61HjED9MXquqlVKHo3c/M=",
      "819F658DBDBB5D333430800891F28361:u/+kuv6DsiUouUOusRRfC8Ti5rCKhsgIyxyOnLH3Mh0=",
      "97D5F3D0A78B050F427B5B300FC03EB5:Be+eZS6KqUc5Lc2iF4YAcLEe+S78nuLCK45HF/dDGDU=",
      "9B730D57F59135CF774023F0DC1A99E7:l2Jy2Q3X1MPar8qMDGSHWWhdsVsYQ7hsqEYFMA6D8fI=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "14.10",
    // chunk 1000
    // chunk 1001 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1002
    // chunk 1003 — EID_TwistDaytona
    // chunk 1004 — Fungus King set
    entries: [
      "258AB620A71C14508FB6614003DCD34E:fjPUuwSZbKfHlvSh8RMyVjR2SVTcVrGNpWvyjNVQ8Xw=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "AFCCB7C08EC6957EEDDAAD676C3D3513:MuovEXob241ie6/RP76ImUk+MExLdl+bszvxCHNtg0U=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "14.20",
    // chunk 1000
    // chunk 1001 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1002
    // chunk 1003 — EID_TwistDaytona
    // chunk 1004 — Fungus King set
    // chunk 1005 — EID_Backspin_R3NAI, Glider_ID_241_BackspinMale_97LM4, Pickaxe_ID_465_BackspinMale1H_R40E7
    entries: [
      "258AB620A71C14508FB6614003DCD34E:fjPUuwSZbKfHlvSh8RMyVjR2SVTcVrGNpWvyjNVQ8Xw=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "AFCCB7C08EC6957EEDDAAD676C3D3513:MuovEXob241ie6/RP76ImUk+MExLdl+bszvxCHNtg0U=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "E48EFA857D8E6914B2505B05AADFB193:4AUdytefPzWNT8c11iGtU4xcGNWEgzpMJbxTjUq3NS0=",
    ],
    unknownChunks: 0,
  },
  {
    build: "14.30",
    // chunk 1000 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1001 — EID_Shorts
    // chunk 1002
    // chunk 1003 — Fungus King set
    entries: [
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "14.40",
    // chunk 1000 — EID_TheShow
    // chunk 1001 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1002 — EID_Shorts
    // chunk 1003
    // chunk 1004 — BID_634_York_Female, BID_635_York_Male, CID_905_Athena_Commando_M_York, CID_906_Athena_Commando_M_York_B, CID_907_Athena_Commando_M_York_C, CID_908_Athena_Commando_M_York_D, CID_909_Athena_Commando_M_York_E, CID_910_Athena_Commando_F_York, CID_911_Athena_Commando_F_York_B, CID_912_Athena_Commando_F_York_C, CID_913_Athena_Commando_F_York_D, CID_914_Athena_Commando_F_York_E, Glider_ID_248_York, Pickaxe_ID_491_YorkMale
    // chunk 1005 — Fungus King set
    entries: [
      "1CE4B8636E40B4AF8858511CE01A98E3:+vewfAbMTec/enBaWVzzCxiHw8WLTJvfAWzFmcOJT4Y=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "828B24CF7786DF74D8511CA89DEED8CF:nCahv7mQhidmYXSmKif6z7d6bQ60mdPQ7SrdZ7a3GaE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "14.50",
    // chunk 1000 — EID_TheShow
    // chunk 1001 — BID_643_Tapdance, Glider_ID_251_TapDanceFemale, Pickaxe_ID_500_TapDanceFemale1H
    // chunk 1002 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1003 — EID_Shorts
    // chunk 1004 — BID_629_LunchBox, EID_LunchBox, Pickaxe_ID_479_LunchBox1H
    // chunk 1005
    // chunk 1006 — BID_642_Embers, Glider_ID_250_EmbersMale, Pickaxe_ID_492_EmbersMale, Wrap_298_Embers
    // chunk 1007 — BID_634_York_Female, BID_635_York_Male, CID_905_Athena_Commando_M_York, CID_906_Athena_Commando_M_York_B, CID_907_Athena_Commando_M_York_C, CID_908_Athena_Commando_M_York_D, CID_909_Athena_Commando_M_York_E, CID_910_Athena_Commando_F_York, CID_911_Athena_Commando_F_York_B, CID_912_Athena_Commando_F_York_C, CID_913_Athena_Commando_F_York_D, CID_914_Athena_Commando_F_York_E, Glider_ID_248_York, Pickaxe_ID_491_YorkMale
    // chunk 1008 — EID_JanuaryBop, EID_SandwichBop
    // chunk 1009 — Fungus King set
    entries: [
      "1CE4B8636E40B4AF8858511CE01A98E3:+vewfAbMTec/enBaWVzzCxiHw8WLTJvfAWzFmcOJT4Y=",
      "204D49F063979C3AF87EF896D074D1CF:SaYFk+GEE7mL4dsgs0v0VGR5ER4TwH8uTNX5XqSglu8=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "566C4D92AF66F45DF5E2D7EB43CC27AE:EuAYwU5tQBXzGoSj5BMc7S5yFfe9wZ2qrzx/hIHpnqw=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "5A1170F589134C4D68AAA2B5AA6EDA69:bfro7s6Qtde/H7C4zc6MJdpua1mhem8HywLluxBLDrg=",
      "828B24CF7786DF74D8511CA89DEED8CF:nCahv7mQhidmYXSmKif6z7d6bQ60mdPQ7SrdZ7a3GaE=",
      "B1EB196DD39D0736E7E08F99B07D8B9A:1fDhBY8uhi++l6QQPL2YtxZgUv04OZoMGBrH+yN8yKM=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "14.60",
    // chunk 1000 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1001 — EID_Shorts
    // chunk 1003
    // chunk 1004 — EID_DontSneeze
    // chunk 1005 — Devourer Of Worlds event
    // chunk 1006 — Fungus King set
    // chunk 1007 — BID_653_Football20_1BS75, CID_937_Athena_Commando_M_Football20_UIC2Q, CID_938_Athena_Commando_M_Football20_B_I18W6, CID_939_Athena_Commando_M_Football20_C_9OP0F, CID_940_Athena_Commando_M_Football20_D_ZID7Q, CID_941_Athena_Commando_M_Football20_E_KNWUY, CID_942_Athena_Commando_F_Football20_YQUPK, CID_943_Athena_Commando_F_Football20_B_GR3WN, CID_944_Athena_Commando_F_Football20_C_FO6IY, CID_945_Athena_Commando_F_Football20_D_G1UYT, CID_946_Athena_Commando_F_Football20_E_EFKP3, CID_947_Athena_Commando_M_Football20Referee_IN7EY, CID_949_Athena_Commando_M_Football20Referee_C_SMMEY, CID_950_Athena_Commando_M_Football20Referee_D_MIHME, CID_951_Athena_Commando_M_Football20Referee_E_QBIBA, CID_952_Athena_Commando_F_Football20Referee_ZX4IC, CID_953_Athena_Commando_F_Football20Referee_B_5SV7Q, CID_955_Athena_Commando_F_Football20Referee_D_OFZIL, CID_956_Athena_Commando_F_Football20Referee_E_DQTP6, EID_Football20Flag_C3QEE, EID_FootballTD_U2HZI
    entries: [
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "A34195EF9068F0DD323EA0B07305EA47:eYcw2YEjssIAsJMgaWYPQQCBFcRvvkj9WoRVV+P3cBo=",
      "C60475E046D0F0FBCFE6DE6F9E040E0E:Wc6IzWuqnm7EHqcSx14i6KwXwl4+PmQq180ESMdR+08=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "F78569F2AD7950F870965BC647904647:e3+Nhzk8SBfmZWoQThFsZmnyJs2AoJ+LQDgMz45YAUE=",
    ],
    unknownChunks: 1,
  },
  {
    build: "15.00",
    // chunk 1000 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1001 — EID_Shorts
    // chunk 1002
    // chunk 1003 — BID_658_Historian_4RCG3, Glider_ID_257_Historian_VS0BJ, Pickaxe_ID_508_HistorianMale_6BQSW
    // chunk 1004 — EID_DontSneeze
    // chunk 1005 — Fungus King set
    // chunk 1006 — BID_665_Jupiter_XD7AK, EID_Jupiter_7JZ9R, Glider_ID_258_JupiterMale_LB0TE, Pickaxe_ID_510_JupiterMale_G035V
    // chunk 1007 — BID_653_Football20_1BS75, CID_937_Athena_Commando_M_Football20_UIC2Q, CID_938_Athena_Commando_M_Football20_B_I18W6, CID_939_Athena_Commando_M_Football20_C_9OP0F, CID_940_Athena_Commando_M_Football20_D_ZID7Q, CID_941_Athena_Commando_M_Football20_E_KNWUY, CID_942_Athena_Commando_F_Football20_YQUPK, CID_943_Athena_Commando_F_Football20_B_GR3WN, CID_944_Athena_Commando_F_Football20_C_FO6IY, CID_945_Athena_Commando_F_Football20_D_G1UYT, CID_946_Athena_Commando_F_Football20_E_EFKP3, CID_947_Athena_Commando_M_Football20Referee_IN7EY, CID_949_Athena_Commando_M_Football20Referee_C_SMMEY, CID_950_Athena_Commando_M_Football20Referee_D_MIHME, CID_951_Athena_Commando_M_Football20Referee_E_QBIBA, CID_952_Athena_Commando_F_Football20Referee_ZX4IC, CID_953_Athena_Commando_F_Football20Referee_B_5SV7Q, CID_955_Athena_Commando_F_Football20Referee_D_OFZIL, CID_956_Athena_Commando_F_Football20Referee_E_DQTP6, EID_Football20Flag_C3QEE, EID_FootballTD_U2HZI
    entries: [
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "8566FD040AC2B245597E11D1F85DB4E5:SEoqoweofxmXfxu848wKn1UJhwU7oQ2w2F0lBst+FnU=",
      "A34195EF9068F0DD323EA0B07305EA47:eYcw2YEjssIAsJMgaWYPQQCBFcRvvkj9WoRVV+P3cBo=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "D83FAFF508200C47DF03BDFF2F801FEC:s9P7AOkoCuPm/506hyAKzuRaIh0xzV9YZON4oDs7GoY=",
      "F78569F2AD7950F870965BC647904647:e3+Nhzk8SBfmZWoQThFsZmnyJs2AoJ+LQDgMz45YAUE=",
    ],
    unknownChunks: 0,
  },
  {
    build: "15.10",
    // chunk 1000
    // chunk 1001
    // chunk 1002 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1003 — EID_Shorts
    // chunk 1004 — Pickaxe_ID_532_WombatFemale_CWE2D, Pickaxe_ID_533_WombatMale_L7QPQ
    // chunk 1005
    // chunk 1006
    // chunk 1007 — BID_658_Historian_4RCG3, Glider_ID_257_Historian_VS0BJ, Pickaxe_ID_508_HistorianMale_6BQSW
    // chunk 1008
    // chunk 1009
    // chunk 1010 — EID_HNYGoodRiddance
    // chunk 1012 — Fungus King set
    // chunk 1013 — BID_665_Jupiter_XD7AK, EID_Jupiter_7JZ9R, Glider_ID_258_JupiterMale_LB0TE, Pickaxe_ID_510_JupiterMale_G035V
    // chunk 1014 — EID_LetsBegin
    // chunk 1015 — EID_Feral
    entries: [
      "000A05AF03AE10ABB2059F29ACBF7D4B:3KrmPu2Ha/X0oy/MWd0a4O8JhJWli5MdtfG4XzeB248=",
      "0DD695EB05DDF1067D46B2F758160F3E:H8eacvW3rgmZFvWGGwXfojcIBMrQUL+FJQ1x3dzzVm0=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "4C8D53A32D85124D08A3DCE6D3474A30:gam5sVciLPzKr+wmWOoctLo5HFqBvBLKKcxh6ZV1kn0=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "7AEE99564551FF8EE98E6887410AE8E2:Cumd3/0knsdwt4bl7zNQw8MKmmIuC/4wYVfVtQq5d2o=",
      "8566FD040AC2B245597E11D1F85DB4E5:SEoqoweofxmXfxu848wKn1UJhwU7oQ2w2F0lBst+FnU=",
      "922A62BF1FB397B890EADCC9ED9E6F90:OvZzqErOUkh5FciEJD8JI+lu4X5NmK5TtzvCK6F5RM4=",
      "B4585A36D49CF15E1E236775B8C659C1:Ced0+UTeTBbDhnHM9mLTk5qxlz3YZK6dEn1U+NTxOko=",
      "C2216794035D5FC95DCC07FA72E1EC86:4CS9WyhB+tpbl/w4bd+9cnjWZTf0NCO8zl1/6TmIQeM=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "D83FAFF508200C47DF03BDFF2F801FEC:s9P7AOkoCuPm/506hyAKzuRaIh0xzV9YZON4oDs7GoY=",
      "DC912741D5C6F75E4B0FEE33D7E3ECB5:0J6tWhEx0Nxw49VokIyykSs5sL5aFPgk2QJn9b5bAi8=",
      "EBA3BC7F0023BE91CE5EFB7E1BC001A8:MdKbawNIe4qCuGaB4q7+4cy8keyDnJnxZLa7HLC0W4A=",
    ],
    unknownChunks: 1,
  },
  {
    build: "15.20",
    // chunk 1000
    // chunk 1001 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1002 — EID_Shorts
    // chunk 1003 — EID_Kilo_VD0PK
    // chunk 1004 — BID_687_GrilledCheese_C9FB6, EID_GrilledCheese_N31C9, Pickaxe_ID_538_GrilledCheeseMale_Z7YMW
    // chunk 1005
    // chunk 1006
    // chunk 1007 — BID_689_TyphoonRobot_SMLZ7, EID_Typhoon_VO9OF, Pickaxe_ID_542_TyphoonFemale1H_CTEVQ, Pickaxe_ID_543_TyphoonRobotMale_S4B4M
    // chunk 1008 — CID_995_Athena_Commando_M_GlobalFB_H5OIJ, CID_996_Athena_Commando_M_GlobalFB_B_RVED4, CID_997_Athena_Commando_M_GlobalFB_C_N6I4H, CID_998_Athena_Commando_M_GlobalFB_D_UTIB8, CID_999_Athena_Commando_M_GlobalFB_E_OISU6, CID_A_001_Athena_Commando_F_GlobalFB_HDL2W, CID_A_002_Athena_Commando_F_GlobalFB_B_0CH64, CID_A_003_Athena_Commando_F_GlobalFB_C_J4H5J, CID_A_004_Athena_Commando_F_GlobalFB_D_62OZ5, CID_A_005_Athena_Commando_F_GlobalFB_E_GTH5I
    // chunk 1009 — Pickaxe_ID_535_ConvoyTarantulaMale_GQ82N
    // chunk 1011 — Fungus King set
    // chunk 1012 — EID_Psychic_7SO2Z
    entries: [
      "28C5CD0467F2271365DA8AC4DE122672:I1ujTTKWOz0A5LcFiCwKJXQl9bnMpW9yhvY13UaWo1Y=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "40E9F547033360DFC0DD09743229B87C:x0/WK54ohwsadmVGHIisJNyHC8MqlU8bg2H+BsaEBtc=",
      "488F01C34A9A24115776EA801A6E7E1B:WB1TFXsB2Cywzb16hZ2HdBc8X1FsTVqzlDwhyJO8Pcc=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "8675F0B46A008B0B6C0ABDD41A619443:9JYZhRB5Kld9h7zVQTbfSyNJvhz9UaJ17HIAPZH8TwQ=",
      "9261CD0F921EAA3CD6AA8C0716FB042B:W+yzeWWxWnA530lwV8nLi2BE+TD5MCXS11th7UphmPQ=",
      "98BCB8B7136162178BF364D6105BB9B7:c1dhB+vWHWRw3YvWpsHRj9Ayj8JjdqYOLnyr0YImxVo=",
      "B3BE1C036099F140800BB7D5FF1D9C49:bLt9+35t2O26OTgiEMuUCvH1kn+lGjTjhaEEoiz4CtE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CD6B95C728B11810F8EE4C396D02EFCA:Fulo/BAgbJwmOju1xu/05XnxLDbenI4bDEb2rUyf5hw=",
    ],
    unknownChunks: 2,
  },
  {
    build: "15.21",
    // chunk 1000
    // chunk 1001
    // chunk 1002 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1003 — EID_Shorts
    // chunk 1004 — EID_Kilo_VD0PK
    // chunk 1005 — BID_687_GrilledCheese_C9FB6, EID_GrilledCheese_N31C9, Pickaxe_ID_538_GrilledCheeseMale_Z7YMW
    // chunk 1006
    // chunk 1007
    // chunk 1008 — BID_689_TyphoonRobot_SMLZ7, EID_Typhoon_VO9OF, Pickaxe_ID_542_TyphoonFemale1H_CTEVQ, Pickaxe_ID_543_TyphoonRobotMale_S4B4M
    // chunk 1009 — CID_995_Athena_Commando_M_GlobalFB_H5OIJ, CID_996_Athena_Commando_M_GlobalFB_B_RVED4, CID_997_Athena_Commando_M_GlobalFB_C_N6I4H, CID_998_Athena_Commando_M_GlobalFB_D_UTIB8, CID_999_Athena_Commando_M_GlobalFB_E_OISU6, CID_A_001_Athena_Commando_F_GlobalFB_HDL2W, CID_A_002_Athena_Commando_F_GlobalFB_B_0CH64, CID_A_003_Athena_Commando_F_GlobalFB_C_J4H5J, CID_A_004_Athena_Commando_F_GlobalFB_D_62OZ5, CID_A_005_Athena_Commando_F_GlobalFB_E_GTH5I
    // chunk 1010 — Pickaxe_ID_535_ConvoyTarantulaMale_GQ82N
    // chunk 1012 — Fungus King set
    // chunk 1013 — EID_Psychic_7SO2Z
    entries: [
      "024641850664615E97BE1533A4F3365E:Ut4/ICU0gseFN8MGgYyUTmWidRtj9yeo/NNBp4y/7hs=",
      "28C5CD0467F2271365DA8AC4DE122672:I1ujTTKWOz0A5LcFiCwKJXQl9bnMpW9yhvY13UaWo1Y=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "40E9F547033360DFC0DD09743229B87C:x0/WK54ohwsadmVGHIisJNyHC8MqlU8bg2H+BsaEBtc=",
      "488F01C34A9A24115776EA801A6E7E1B:WB1TFXsB2Cywzb16hZ2HdBc8X1FsTVqzlDwhyJO8Pcc=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "8675F0B46A008B0B6C0ABDD41A619443:9JYZhRB5Kld9h7zVQTbfSyNJvhz9UaJ17HIAPZH8TwQ=",
      "9261CD0F921EAA3CD6AA8C0716FB042B:W+yzeWWxWnA530lwV8nLi2BE+TD5MCXS11th7UphmPQ=",
      "98BCB8B7136162178BF364D6105BB9B7:c1dhB+vWHWRw3YvWpsHRj9Ayj8JjdqYOLnyr0YImxVo=",
      "B3BE1C036099F140800BB7D5FF1D9C49:bLt9+35t2O26OTgiEMuUCvH1kn+lGjTjhaEEoiz4CtE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CD6B95C728B11810F8EE4C396D02EFCA:Fulo/BAgbJwmOju1xu/05XnxLDbenI4bDEb2rUyf5hw=",
    ],
    unknownChunks: 1,
  },
  {
    build: "15.30",
    // chunk 1000 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1001 — Glider_ID_273_MainframeMale_P06W7, Pickaxe_ID_546_MainframeMale_XW9S6
    // chunk 1002 — EID_Shorts
    // chunk 1003 — BID_586_Tar_DIJGH, EID_Tar_S9YVE, LSID_273_Tar_ITJ9S, Pickaxe_ID_548_TarMale_8X3BY
    // chunk 1004
    // chunk 1005
    // chunk 1006 — EID_ModerateAmount_9LUN1
    // chunk 1007 — Pickaxe_ID_535_ConvoyTarantulaMale_GQ82N
    // chunk 1008 — Fungus King set
    // chunk 1009 — EID_Psychic_7SO2Z
    entries: [
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "2E1C06DB5781755F3F06D95B6612BB3E:aTN33nTPI+qQ+osYxcMa4FjlyajAzhIxRzEcoAr8iAI=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "4E7938F1FAC98BDF378823116712AC7A:jbZVgprILTQomUdGeJF0PsAFAJxsSCs5cKcXweZMAg0=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "6B91F0DFD2780364EC6FC5E531665208:sBhYta4JrxcssCLVBkFXeJpKa7gQKHepqu9840vo6h4=",
      "91BEC79063CD316E69E79215E0CE6437:uE56sTOQozw4kZfj70CQIEFqQOFORE1+mZhMhccG1z4=",
      "B3BE1C036099F140800BB7D5FF1D9C49:bLt9+35t2O26OTgiEMuUCvH1kn+lGjTjhaEEoiz4CtE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CD6B95C728B11810F8EE4C396D02EFCA:Fulo/BAgbJwmOju1xu/05XnxLDbenI4bDEb2rUyf5hw=",
    ],
    unknownChunks: 0,
  },
  {
    build: "15.40",
    // chunk 1000 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1001
    // chunk 1002 — EID_Shorts
    // chunk 1003 — BID_703_KeplerMale_ZTFJU, BID_704_KeplerFemale_C0L25, EID_KeplerFemale_C98JD, Glider_ID_276_Kepler_BEUUP, Pickaxe_ID_551_KeplerFemale_AOYI5
    // chunk 1004
    // chunk 1005
    // chunk 1006 — EID_GasStation_104FQ
    // chunk 1007 — Fungus King set
    // chunk 1008 — BID_701_SkirmishMale_5LH4I, BID_702_SkirmishFemale_P9FE3, Glider_ID_277_Skirmish_9KK2W, LSID_274_Skirmish_PJ9TZ, Pickaxe_ID_553_SkirmishFemale_J2JXX, Pickaxe_ID_554_SkirmishMale_ML78Q
    // chunk 1009
    entries: [
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "30B53CD6A14D4EE40C71C60E9EE0DD93:RFvcbS74Q3YPnQpxUbhafzeiqVYKv6Fxukfi77h2TdI=",
      "312398E80AB6209B22CAA2EBAB2DB35B:QZ5uhBnQSeK4b+u9E6PTfw7j2scPMTPX4fFTOJWIwEM=",
      "4009CB877085F3B3B0D76A686465A140:gMLJXUbFcIrqqUlAuoMI1b27KdWHBVJJeJWdYV1Iiro=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "99B0F5AFB03FFA1BC3B8AFF75267CAD2:d4GffGn7ENqL9SpO5wnhKZzqzpr8S/4LQS2P+QD2wy4=",
      "A5A71DA2F913ED0FD001BBCEC58F97FF:gFC4LJXINTgSLc8Gd6tYuSmuLHP+4AthS6eF52C93M0=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "F395571A36D2BD888861E61EEBD45AF8:D/35GPTIOKbdfmpxRJmHTkjNXcWv+XdSmTxQt6z1hvI=",
      "FA393ED7DFD20657B9C8659CB0295F64:G5wmtVhL0E8/+gpxHPK3HGJJ5RvfoWyeYrLJ3Awm9f4=",
    ],
    unknownChunks: 0,
  },
  {
    build: "15.50",
    // chunk 1000 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1001 — BID_703_KeplerMale_ZTFJU, BID_704_KeplerFemale_C0L25, EID_KeplerFemale_C98JD, Glider_ID_276_Kepler_BEUUP, Pickaxe_ID_551_KeplerFemale_AOYI5
    // chunk 1002
    // chunk 1003
    // chunk 1004 — EID_GasStation_104FQ
    // chunk 1005 — BID_710_SmallFry_GDE1J, Pickaxe_ID_558_SmallFryMale_YBD34
    // chunk 1006 — Fungus King set
    // chunk 1007
    entries: [
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "4009CB877085F3B3B0D76A686465A140:gMLJXUbFcIrqqUlAuoMI1b27KdWHBVJJeJWdYV1Iiro=",
      "58B5E58B5C848D31BC6A2F3F3514879E:feweaybOhbdoBVX5cGTOqlx4jf3GdPmKanEfcm3tuUM=",
      "99B0F5AFB03FFA1BC3B8AFF75267CAD2:d4GffGn7ENqL9SpO5wnhKZzqzpr8S/4LQS2P+QD2wy4=",
      "A5A71DA2F913ED0FD001BBCEC58F97FF:gFC4LJXINTgSLc8Gd6tYuSmuLHP+4AthS6eF52C93M0=",
      "AF3080C00CB8CB301C167B00E9671CD4:wLmQDoGeYBN8Og/IMDoGxuuQNy7M+RQkKtajSZiOebE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "FC4FC301558D3E9321A55180263EB17B:OXujupiNRNT6+b1g1dg2IXPtdQyfoNPUuvtgqfXnlEY=",
    ],
    unknownChunks: 0,
  },
  {
    build: "16.00",
    // chunk 1000
    // chunk 1001 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1002 — EID_Noodles_X6R9E
    // chunk 1003 — Fungus King set
    // chunk 1004 — EID_RhymeLock_5B2Y3
    entries: [
      "286270CA017B478C6FF6B5B815428F93:OUbNW00OmQLCd9iLA13soMU4wYtd0RTc+lEkoPdvF4U=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "77B485EBF8E72CC8CD19F8646A6D0491:SXUHJQDuxBGv0PzDtuVsDxNyubG/pgH9s9FMvimS0YQ=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CCFB247DE6ED8DB4856E039A5AE681B8:Z8ixoqcCEiFqUH1qec+yUNQTP1+D1xQjYw6FDpUQa9c=",
    ],
    unknownChunks: 0,
  },
  {
    build: "16.10",
    // chunk 1000 — BID_736_DayTrader_QS4PD
    // chunk 1001 — EID_Survivorsault_NJ7WC
    // chunk 1002
    // chunk 1003 — BID_531_HardcoreSportzFemale, BID_532_HardcoreSportzMale, Glider_ID_216_HardcoreSportz, Pickaxe_ID_406_HardcoreSportzFemale
    // chunk 1004 — EID_Noodles_X6R9E
    // chunk 1005 — BID_733_TheGoldenSkeletonFemale_SG4HF, Pickaxe_ID_577_TheGoldenSkeletonFemale1H_Y6VJG, Wrap_356_GoldenSkeletonF_FT0B3
    // chunk 1006 — EID_Martian_SK4J6
    // chunk 1007 — Fungus King set
    // chunk 1008 — EID_RhymeLock_5B2Y3
    entries: [
      "09D84C411F2EFF940F5D462000CA5BE0:6Djlf6/XCCTMpI4KbNEHN4X6prgcnfQtru+z+RTHs2s=",
      "1655272875DB718493BB6B09032657D7:xQLpNTDeYJCcQOUQS2ICyfByvhPU3nC5cfJRbPSugdY=",
      "286270CA017B478C6FF6B5B815428F93:OUbNW00OmQLCd9iLA13soMU4wYtd0RTc+lEkoPdvF4U=",
      "2DCD2E2A9A816AA9035999F8E6F85F6E:6xM4ZYt0UAylyuIgFrmOgq4fYVH2ChEzQNcl8KGQF0o=",
      "77B485EBF8E72CC8CD19F8646A6D0491:SXUHJQDuxBGv0PzDtuVsDxNyubG/pgH9s9FMvimS0YQ=",
      "7B1151E3094646DFFD37B6492B117FDB:4WxNHdTgHDEpGjzIV2XIjGO41kyiwggFQpdq8y+o1jY=",
      "C5C1E0742C0BFE4264242F3774C13B41:BO5aZnDZhvHsUFLsJD2vtYCQ6iYpX7Lhl565nDsBhaE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "CCFB247DE6ED8DB4856E039A5AE681B8:Z8ixoqcCEiFqUH1qec+yUNQTP1+D1xQjYw6FDpUQa9c=",
    ],
    unknownChunks: 0,
  },
  {
    build: "16.30",
    // chunk 1000 — EID_Quantity_39X5D
    // chunk 1001 — EID_OverUnder_K3T0G
    // chunk 1002 — EID_Survivorsault_NJ7WC
    // chunk 1003
    // chunk 1004 — BID_733_TheGoldenSkeletonFemale_SG4HF, Pickaxe_ID_577_TheGoldenSkeletonFemale1H_Y6VJG, Wrap_356_GoldenSkeletonF_FT0B3
    // chunk 1005 — BID_745_BuffCatComic_AB1AX, LSID_287_BuffCatComic_JBE9O, MusicPack_084_BuffCatComic_5JC9Y, Pickaxe_ID_588_BuffCatComicMale_12ZAD
    // chunk 1006 — Fungus King set
    // chunk 1007 — BID_744_CavernMale_CF6JE, LSID_296_Cavern_60EXF, Pickaxe_ID_589_CavernMale_9U0A8
    entries: [
      "08788A9DA34F4164ADA4F09FBF698CC3:DlhRrdBGDNADUAMRj4oAUwwR2j33Nr2ZNg2CU3i1/Pg=",
      "099F6A310406E06EEE5B011F57E8ADC5:eN0n2GvhVfW8LKPVA+LvlegACOXLQLyOxt24wFERaio=",
      "1655272875DB718493BB6B09032657D7:xQLpNTDeYJCcQOUQS2ICyfByvhPU3nC5cfJRbPSugdY=",
      "5776BD1A9BFC4EEEB7DD1FCA71B9C39C:jkYOI3VSLqXBCMYyxpfl/soGCBdplmqs8C2AOg1pcGU=",
      "7B1151E3094646DFFD37B6492B117FDB:4WxNHdTgHDEpGjzIV2XIjGO41kyiwggFQpdq8y+o1jY=",
      "B229884F839295B4B9EDC380B045C64B:SVmPvZenzQ5Si17i8daUFyKoOGDtaH4YZtsF1s2XkxE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "FD0C3696948675DC3C2CBF5098D57D0D:rBWyTh/AVyZxi2oiQxM/OeD/HYZOSdVidEQeKoowV6U=",
    ],
    unknownChunks: 0,
  },
  {
    build: "16.40",
    // chunk 1000 — EID_Quantity_39X5D
    // chunk 1001 — EID_OverUnder_K3T0G
    // chunk 1002 — EID_TwistWasp_T2I4J
    // chunk 1003 — EID_Survivorsault_NJ7WC
    // chunk 1004
    // chunk 1005
    // chunk 1006 — EID_TwistFire_I2VTA
    // chunk 1007 — CID_A_080_Athena_Commando_M_Hardwood_I15AL, CID_A_081_Athena_Commando_M_Hardwood_B_JRP29, CID_A_082_Athena_Commando_M_Hardwood_C_YS5XC, CID_A_083_Athena_Commando_M_Hardwood_D_7S0PN, CID_A_084_Athena_Commando_M_Hardwood_E_II9YS, CID_A_085_Athena_Commando_F_Hardwood_K7ZZ1, CID_A_086_Athena_Commando_F_Hardwood_B_B7ZQA, CID_A_087_Athena_Commando_F_Hardwood_C_AOU16, CID_A_088_Athena_Commando_F_Hardwood_D_WPHX2, CID_A_089_Athena_Commando_F_Hardwood_E_4TDWH, EID_BasketballDribble_E6OJV, TOY_Basketball_Hookshot_LUWQ6
    // chunk 1008 — BID_733_TheGoldenSkeletonFemale_SG4HF, Pickaxe_ID_577_TheGoldenSkeletonFemale1H_Y6VJG, Wrap_356_GoldenSkeletonF_FT0B3
    // chunk 1009
    // chunk 1010 — CID_A_094_Athena_Commando_F_Cavern_33LMC
    // chunk 1011 — BID_745_BuffCatComic_AB1AX, LSID_287_BuffCatComic_JBE9O, MusicPack_084_BuffCatComic_5JC9Y, Pickaxe_ID_588_BuffCatComicMale_12ZAD
    // chunk 1012 — Fungus King set
    // chunk 1013 — BID_744_CavernMale_CF6JE, LSID_296_Cavern_60EXF, Pickaxe_ID_589_CavernMale_9U0A8
    entries: [
      "08788A9DA34F4164ADA4F09FBF698CC3:DlhRrdBGDNADUAMRj4oAUwwR2j33Nr2ZNg2CU3i1/Pg=",
      "099F6A310406E06EEE5B011F57E8ADC5:eN0n2GvhVfW8LKPVA+LvlegACOXLQLyOxt24wFERaio=",
      "163D68B009421CA82956BDD63659F7C0:SAE6Yruow/8IPkoOuzYEnjJFyvBuwLNI11z9/5EfyL0=",
      "1655272875DB718493BB6B09032657D7:xQLpNTDeYJCcQOUQS2ICyfByvhPU3nC5cfJRbPSugdY=",
      "5776BD1A9BFC4EEEB7DD1FCA71B9C39C:jkYOI3VSLqXBCMYyxpfl/soGCBdplmqs8C2AOg1pcGU=",
      "74245D2573276B4C9ECCF61B23367A72:I5LtJ72UAlZ9XIupxkzRJKiRnSEkEvEc5D8+Ss4u2Ik=",
      "793D221E5331282DD7F3681100944880:B5R64E9EZQD1lHmmyUV+9a1XUEOcYfdopJ3avEIcVxE=",
      "7A59383C41DD998408A74BC37C7D6887:nSrruhpHV3ZEPPECeqWkMh/6mBFzQD8yEFKZS6oJeu8=",
      "7B1151E3094646DFFD37B6492B117FDB:4WxNHdTgHDEpGjzIV2XIjGO41kyiwggFQpdq8y+o1jY=",
      "A08F80FECB766B071C66017C5902DBD1:Q4sRGzjjbRTMZ3HwAmiC6a6+017KgXUsLapzs71OWEs=",
      "B0030ECDA329A8B589D249F794EA90B3:BfF0FYJQJ71DMUBmClT0DppsOy+1Syn8fGu6qNtTgXE=",
      "B229884F839295B4B9EDC380B045C64B:SVmPvZenzQ5Si17i8daUFyKoOGDtaH4YZtsF1s2XkxE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "FD0C3696948675DC3C2CBF5098D57D0D:rBWyTh/AVyZxi2oiQxM/OeD/HYZOSdVidEQeKoowV6U=",
    ],
    unknownChunks: 0,
  },
  {
    build: "16.50",
    // chunk 1000 — EID_TwistWasp_T2I4J
    // chunk 1001
    // chunk 1002 — Socks emote
    // chunk 1003
    // chunk 1004
    // chunk 1005 — EID_TwistFire_I2VTA
    // chunk 1006 — CID_A_080_Athena_Commando_M_Hardwood_I15AL, CID_A_081_Athena_Commando_M_Hardwood_B_JRP29, CID_A_082_Athena_Commando_M_Hardwood_C_YS5XC, CID_A_083_Athena_Commando_M_Hardwood_D_7S0PN, CID_A_084_Athena_Commando_M_Hardwood_E_II9YS, CID_A_085_Athena_Commando_F_Hardwood_K7ZZ1, CID_A_086_Athena_Commando_F_Hardwood_B_B7ZQA, CID_A_087_Athena_Commando_F_Hardwood_C_AOU16, CID_A_088_Athena_Commando_F_Hardwood_D_WPHX2, CID_A_089_Athena_Commando_F_Hardwood_E_4TDWH, EID_BasketballDribble_E6OJV, TOY_Basketball_Hookshot_LUWQ6
    // chunk 1007 — BID_733_TheGoldenSkeletonFemale_SG4HF, Pickaxe_ID_577_TheGoldenSkeletonFemale1H_Y6VJG, Wrap_356_GoldenSkeletonF_FT0B3
    // chunk 1008 — Pickaxe_ID_605_GrimMale_8GT61
    // chunk 1009
    // chunk 1010
    // chunk 1011
    // chunk 1012 — CID_A_094_Athena_Commando_F_Cavern_33LMC
    // chunk 1013 — Build Up emote
    // chunk 1014 — Fungus King set
    // chunk 1015 — LSID_305_Downpour_CHB8O
    entries: [
      "163D68B009421CA82956BDD63659F7C0:SAE6Yruow/8IPkoOuzYEnjJFyvBuwLNI11z9/5EfyL0=",
      "234D1D3D37EFF3322E44B31200C1ACEA:T3lGoZ3JIVg7vasMQCr3hjyRo8x+HS1Arh43XvdUKss=",
      "682BB8BC5B0BBE6318CF2164E074E7E8:NA4nCwFqo95pvsqkLXWO2WDdLY+MQGcj97N6t881BQE=",
      "688022C4193EA6D9DF1EDC7F6CF826DA:lOR338TzQ75G7R81RCKTdjYmYCjhSKJIB+ScPYanNow=",
      "74245D2573276B4C9ECCF61B23367A72:I5LtJ72UAlZ9XIupxkzRJKiRnSEkEvEc5D8+Ss4u2Ik=",
      "793D221E5331282DD7F3681100944880:B5R64E9EZQD1lHmmyUV+9a1XUEOcYfdopJ3avEIcVxE=",
      "7A59383C41DD998408A74BC37C7D6887:nSrruhpHV3ZEPPECeqWkMh/6mBFzQD8yEFKZS6oJeu8=",
      "7B1151E3094646DFFD37B6492B117FDB:4WxNHdTgHDEpGjzIV2XIjGO41kyiwggFQpdq8y+o1jY=",
      "8AE930B0D623C1C2B3926C52ECF6250B:uwtZv87e9DU/Z1ZvYB7Pv4TdRQ4/ZRT9nYJCwYSmlbI=",
      "99F8F15A893B9B4BAC2E12BFDCE251B9:1OMIfAluyzGr5kvv03niOQMXp/D+M1s/f/mHTv52Prk=",
      "A08F80FECB766B071C66017C5902DBD1:Q4sRGzjjbRTMZ3HwAmiC6a6+017KgXUsLapzs71OWEs=",
      "AE04BC41397F3D492390E60E59B39CAC:xC3e/4BfPQ5/xQqEKnB+EgmzrOcLiOCqiQCuZB6V9Ac=",
      "B0030ECDA329A8B589D249F794EA90B3:BfF0FYJQJ71DMUBmClT0DppsOy+1Syn8fGu6qNtTgXE=",
      "C6F7AEC922E28FB25AFBC50442F57877:qJNZNWzxSxvlrklYDsNkZek9OD8kGV6lI+Hfmm+k0gE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "F2E3A44428F24B0E4F481938A8E3D8EE:Vgb58eI7kGPp+Ecr8lhE2RMoKeCLFG0sWAEugWV295A=",
    ],
    unknownChunks: 0,
  },
  {
    build: "17.00",
    // chunk 1000 — BID_771_Lasso_ZN4VA
    // chunk 1001 — Henchman cosmetics
    // chunk 1002 — The Macarena emote
    // chunk 1003 — BID_772_Lasso_Polo_BL4WE
    // chunk 1004 — Socks emote
    // chunk 1005 — BID_733_TheGoldenSkeletonFemale_SG4HF, Pickaxe_ID_577_TheGoldenSkeletonFemale1H_Y6VJG, Wrap_356_GoldenSkeletonF_FT0B3
    // chunk 1006 — Build Up emote
    // chunk 1007 — Fungus King set
    // chunk 1008 — LSID_305_Downpour_CHB8O
    entries: [
      "06E3CB03E94C4D850CE185166706E868:jDuRIbxnZBnAH/hUrfRX3qnGyIogSWUHrK6nq7Et3pk=",
      "419567181C57991B12DA9A9AEADAE6DB:nWZ+G2GG0PvarQUg/U/kRpWaJkA2YmmCgixEy4No+7Q=",
      "47668DCAEC0AE101E0402B6105A6DDF5:rSOpMue5liEBVSvy/0JZZGTPsP2QeA7Yw9GdicJHs7Y=",
      "604C6242EB2BF301BB5D4BC6E3AC5A8C:Y7c2+dviThEDuVsG9kIOjMfnLdJUnPMbdaY5gKiVki0=",
      "682BB8BC5B0BBE6318CF2164E074E7E8:NA4nCwFqo95pvsqkLXWO2WDdLY+MQGcj97N6t881BQE=",
      "7B1151E3094646DFFD37B6492B117FDB:4WxNHdTgHDEpGjzIV2XIjGO41kyiwggFQpdq8y+o1jY=",
      "C6F7AEC922E28FB25AFBC50442F57877:qJNZNWzxSxvlrklYDsNkZek9OD8kGV6lI+Hfmm+k0gE=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "F2E3A44428F24B0E4F481938A8E3D8EE:Vgb58eI7kGPp+Ecr8lhE2RMoKeCLFG0sWAEugWV295A=",
    ],
    unknownChunks: 0,
  },
  {
    build: "17.10",
    // chunk 1000 — Pump up the Jam emote
    // chunk 1001 — Henchman cosmetics
    // chunk 1002 — King James set
    // chunk 1003 — The Macarena emote
    // chunk 1004
    // chunk 1005
    // chunk 1006
    // chunk 1007
    // chunk 1008 — Fungus King set
    // chunk 1009
    entries: [
      "01BCAD21B42507D45972A0E634D3BF68:LFzYKDNwUHYxLThhPKfnzmnADCwCZFjZybIL9TaGBkw=",
      "419567181C57991B12DA9A9AEADAE6DB:nWZ+G2GG0PvarQUg/U/kRpWaJkA2YmmCgixEy4No+7Q=",
      "44DB36B2D2B3854669780458D2FE48C4:gtl0smAMRKg8d9TdDH47lUOYCygKzbAPA6/HaXLWy94=",
      "47668DCAEC0AE101E0402B6105A6DDF5:rSOpMue5liEBVSvy/0JZZGTPsP2QeA7Yw9GdicJHs7Y=",
      "738C0E8B5DAB633906DC77FE4C4E48F9:qr1ZfbWRp+uqwBMvEhY1XBj7Sr7SxRsWHN7jqYPaZfU=",
      "97E91E4F436B598D654592793B595536:Pj0lxheibz4Db/C4ehhHGlOalLQAxFCS+2NYkHRbjyQ=",
      "AC44D9C67B1FB24E70D94C827FC465AE:VrHcqJ9hMMqZicx3kS+qFfNXexXR/QA1/1bM+DwgqMw=",
      "C779C5126616BE8EA5FF851D2FF1FF34:uK97yLbZmBvrWhlMlQmYfVWq2l4mRy/CEm5H/zczFDI=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "ECE91B4E506E33C16FA440F4B4313824:dGr4XbhLD3sf28Y3Tawke4Gr/TpwEA5xPOjhgi+ZAKk=",
    ],
    unknownChunks: 0,
  },
  {
    build: "17.20",
    // chunk 1000 — Pump up the Jam emote
    // chunk 1001 — Generic Rift Tour posters
    // chunk 1002 — Henchman cosmetics
    // chunk 1003 — King James set
    // chunk 1004 — The Macarena emote
    // chunk 1005 — Quest Summer Ever set
    // chunk 1006 — Rift Tour in-game posters
    // chunk 1007 — Party Royale Shortnite 2 posters
    // chunk 1008 — Ferrari 296 GTB
    // chunk 1009 — Ferrari cosmetic set
    // chunk 1010 — Fungus King set
    entries: [
      "01BCAD21B42507D45972A0E634D3BF68:LFzYKDNwUHYxLThhPKfnzmnADCwCZFjZybIL9TaGBkw=",
      "3CE25AC56856D0E10426276F61265547:NEtVDXR0qoOfW9lgdS4AuA8dkfd/1I9degcRI9UnvUo=",
      "419567181C57991B12DA9A9AEADAE6DB:nWZ+G2GG0PvarQUg/U/kRpWaJkA2YmmCgixEy4No+7Q=",
      "44DB36B2D2B3854669780458D2FE48C4:gtl0smAMRKg8d9TdDH47lUOYCygKzbAPA6/HaXLWy94=",
      "47668DCAEC0AE101E0402B6105A6DDF5:rSOpMue5liEBVSvy/0JZZGTPsP2QeA7Yw9GdicJHs7Y=",
      "58388BA7BD1643A85EFD49BF26EF5912:Aru327JJHsGKCD2YlQT+Ejy63//vly9ChTdKsfgL75o=",
      "6A2047910081947B9A5DCF542A9AEBE5:V/jMTWL+zbqeIlKCE9+SM3+X69aYbt/cN0+G1D0GBQU=",
      "98CAB76B2CB8406085C8CDF566FFF5DD:cucOYeadgsZAhkdKC7Klc4/BhUe0SnQtF2cwEScRBxw=",
      "BF953D81273D8772F12F57646A49430E:JP2vQQulX3OGMjglMYW7PT3KMCMbia3rtHnuEsuEVxA=",
      "BFE1F518C16A9F061B140D829ADDB0ED:bHkPYjXd71vacoJ4IisL//zEyVLFh+Di8MUqV9KkpFU=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "17.21",
    // chunk 1000 — Pump up the Jam emote
    // chunk 1001 — Rift Tour quests + rewards
    // chunk 1002 — Generic Rift Tour posters
    // chunk 1003 — Henchman cosmetics
    // chunk 1004 — King James set
    // chunk 1005 — The Macarena emote
    // chunk 1006 — Quest Summer Ever set
    // chunk 1007 — Rift Tour in-game posters
    // chunk 1008 — Party Royale Shortnite 2 posters
    // chunk 1009 — Ferrari 296 GTB
    // chunk 1010 — Ferrari cosmetic set
    // chunk 1011 — Fungus King set
    entries: [
      "01BCAD21B42507D45972A0E634D3BF68:LFzYKDNwUHYxLThhPKfnzmnADCwCZFjZybIL9TaGBkw=",
      "29DCC9CAE821CAF43197545BAFB9CDE1:i9A5h7EdSe56nquoLOHdmUB6HKB50OzHpQMLXDjSQkM=",
      "3CE25AC56856D0E10426276F61265547:NEtVDXR0qoOfW9lgdS4AuA8dkfd/1I9degcRI9UnvUo=",
      "419567181C57991B12DA9A9AEADAE6DB:nWZ+G2GG0PvarQUg/U/kRpWaJkA2YmmCgixEy4No+7Q=",
      "44DB36B2D2B3854669780458D2FE48C4:gtl0smAMRKg8d9TdDH47lUOYCygKzbAPA6/HaXLWy94=",
      "47668DCAEC0AE101E0402B6105A6DDF5:rSOpMue5liEBVSvy/0JZZGTPsP2QeA7Yw9GdicJHs7Y=",
      "58388BA7BD1643A85EFD49BF26EF5912:Aru327JJHsGKCD2YlQT+Ejy63//vly9ChTdKsfgL75o=",
      "6A2047910081947B9A5DCF542A9AEBE5:V/jMTWL+zbqeIlKCE9+SM3+X69aYbt/cN0+G1D0GBQU=",
      "98CAB76B2CB8406085C8CDF566FFF5DD:cucOYeadgsZAhkdKC7Klc4/BhUe0SnQtF2cwEScRBxw=",
      "BF953D81273D8772F12F57646A49430E:JP2vQQulX3OGMjglMYW7PT3KMCMbia3rtHnuEsuEVxA=",
      "BFE1F518C16A9F061B140D829ADDB0ED:bHkPYjXd71vacoJ4IisL//zEyVLFh+Di8MUqV9KkpFU=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
    ],
    unknownChunks: 0,
  },
  {
    build: "17.30",
    // chunk 1000 — Rift Tour quests + rewards
    // chunk 1001 — Generic Rift Tour posters
    // chunk 1002 — Henchman cosmetics
    // chunk 1003
    // chunk 1004 — BID_819_Stereo_TE8RC, Glider_ID_306_StereoFemale_0ZZCF, Pickaxe_ID_648_StereoFemale_0DTZ9
    // chunk 1005 — Quest Summer Ever set
    // chunk 1006 — CID_A_159_Athena_Commando_M_Cashier_7K3F0
    // chunk 1007 — Rift Tour in-game posters
    // chunk 1008 — Rift Tour item shop background
    // chunk 1009
    // chunk 1010 — Rift Tour event playlist
    // chunk 1011 — Rift Tour event
    // chunk 1012 — Party Royale Shortnite 2 posters
    // chunk 1013
    // chunk 1014 — Mothership opening animations
    // chunk 1015 — Post Rift Tour quests' rewards
    // chunk 1016 — Alien Hologram Pads (BuffetBubble)
    // chunk 1017 — Ferrari 296 GTB
    // chunk 1018 — Fungus King set
    // chunk 1019 — Ariana Grande cosmetics + Sparkle Skull outfit
    // chunk 1020 — Cammy + Guile (Street Fighter Round 2)
    entries: [
      "29DCC9CAE821CAF43197545BAFB9CDE1:i9A5h7EdSe56nquoLOHdmUB6HKB50OzHpQMLXDjSQkM=",
      "3CE25AC56856D0E10426276F61265547:NEtVDXR0qoOfW9lgdS4AuA8dkfd/1I9degcRI9UnvUo=",
      "419567181C57991B12DA9A9AEADAE6DB:nWZ+G2GG0PvarQUg/U/kRpWaJkA2YmmCgixEy4No+7Q=",
      "49034BA1606B1672C8B634D2C6186807:5ujMnF4IKuvumpfNcUA1yi1mXjy5zBGPg00TJkHlG04=",
      "552DB214510DE1E24F08920F80B0AEC5:GP2CYv9xYYDf6bOnpgm0fnOXa3iI0acXH02ZIaHAElg=",
      "58388BA7BD1643A85EFD49BF26EF5912:Aru327JJHsGKCD2YlQT+Ejy63//vly9ChTdKsfgL75o=",
      "5A03216B7495CB52261D6E0D74DC62CB:tYFoxNFq/lu5imPTcSk5vAX7ZfPNBwi8INXf2hU+YyU=",
      "6A2047910081947B9A5DCF542A9AEBE5:V/jMTWL+zbqeIlKCE9+SM3+X69aYbt/cN0+G1D0GBQU=",
      "71C3BFE2AF0BC8DE7BC3735614CE6263:hNLsvUTUw0cw1WrfOEjm7oSGPfpEZer6R0G7F2El6Q0=",
      "726DD9BDA97CE92DFF162668027518BE:/QdzaWcoVhInSz0Oa0qk+NV3XxRt9WlXwcAu766Y6aY=",
      "7F5ACEFE3F67BC0CCEB59A4E8EB82BAF:iDG2HB2LypEtzw5/EjKVpJmQ1o30BE3nVv01rOTyq64=",
      "8D578CF915DB851F9BE73C937D3565E4:Xk8kUK9cut4tXr0VQjufZdoepp+TzGmlDA7fzYA1rAc=",
      "98CAB76B2CB8406085C8CDF566FFF5DD:cucOYeadgsZAhkdKC7Klc4/BhUe0SnQtF2cwEScRBxw=",
      "A10B1E27AF53CDC331BF4797C97B6B9B:fy5fTzL7HXpOBRg49CHm/E8Iptd4X12eYNBAeSa5CY4=",
      "A31042B93988941EE77BC1E2DA6AA05E:pDUufUGsOVTv3LuXoq56xwz8HRnzlrHTvTLWbzBaPcU=",
      "B9C9B09F29DF6BC9DA94C36184CECFFF:1/E0M5TV90UjL3PR+sqOzaRiMRpF8ByTmfVayVEL/Ig=",
      "BB09F8C7991800CA61A7144E3A6219FA:o+Hvu5rCygQz66xIyk0SANceWaptKHLEls3vZaMW9oc=",
      "BF953D81273D8772F12F57646A49430E:JP2vQQulX3OGMjglMYW7PT3KMCMbia3rtHnuEsuEVxA=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "E47EFA3166A5D7B35CEC27B19AC66AE5:JURSqAHhHK6YqLP5rKhCO+SQ2oql4NqJaoaeNGtsrM8=",
      "F3A99CD0D4F58EECEEB0D112506AD846:ZZtCRPcKk6itVryDavp7uZFIXiZF5CW0O9b+8Zt2Oag=",
    ],
    unknownChunks: 0,
  },
  {
    build: "17.40",
    // chunk 1000 — BID_819_Stereo_TE8RC, Glider_ID_306_StereoFemale_0ZZCF, Pickaxe_ID_648_StereoFemale_0DTZ9
    // chunk 1001 — EID_Vivid_I434X, Glider_ID_308_VividMale_H8JAS, Pickaxe_ID_661_VividMale1H_ZN6Q0
    // chunk 1002 — EID_Boomer_N2RQT
    // chunk 1003 — BID_827_AntiquePal_BL5ER, Pickaxe_ID_649_AntiquePalMale1H_GBT24
    // chunk 1004 — Fungus King set
    // chunk 1005 — BID_832_Lavish_TV630, Pickaxe_ID_653_LavishMale1H_SWKJB
    // chunk 1006
    // chunk 1007 — BID_826_RuckusMini_4EP8L, EID_RuckusMini_HW9YF, Pickaxe_ID_659_RuckusMini_O051M, Wrap_387_RuckusMini_6I5DM
    entries: [
      "552DB214510DE1E24F08920F80B0AEC5:GP2CYv9xYYDf6bOnpgm0fnOXa3iI0acXH02ZIaHAElg=",
      "63722D44ECCA0F4178B85F5A6BC4C31B:j42UL0bmfBkli6Aj92wWABwFby5rAplP/Ac6nh9kRvA=",
      "987329E3B70FEAD522EBF7435E5CA6DD:j4zyQQh25LYcjUO0HYDsBzmqLSXR5r98UKdC0xeTyHI=",
      "9E9072AA036FB1FF6B2AAD7BEFE7BF17:ORHgZOt4Zrtc8dLSx6jCsWZ3Z6AwPJiSiFAkZRMK3kM=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "ED088B11311A599D6225CE85545F019A:1NMRh4JMXRL9XW8Kb6zo4/F10dwLJC1+kPm6D6DudCE=",
      "F4729DF9DB149229267F9389E3C95851:DCXGOUUTWG8jFuEryO+32mXKJsQgQe+Fp82u7mHiYFU=",
      "F6E92DDBC70C8184E837D31905B2F2A7:UCSPatT+yv3YH2x0Ks+2GSXhSSu+3ZvZs6Lai3oOi0Y=",
    ],
    unknownChunks: 0,
  },
  {
    build: "17.50",
    // chunk 1000 — EID_MyEffort_BT5Z0
    // chunk 1001 — EID_Shindig_8W1AW
    // chunk 1002 — BID_837_Dragonfruit_0IZM3, Pickaxe_ID_664_DragonfruitMale1H_4BIXL, Wrap_391_Dragonfruit_YVN1M
    // chunk 1003 — Party Royale posters
    // chunk 1004 — EID_SmallFry_KFFA1
    // chunk 1005
    // chunk 1006 — EID_Downward_8GZUA
    // chunk 1007 — Sky Fire event
    // chunk 1008 — EID_Butter_1R26Q
    // chunk 1009 — EID_Boomer_N2RQT
    // chunk 1010 — BID_827_AntiquePal_BL5ER, Pickaxe_ID_649_AntiquePalMale1H_GBT24
    // chunk 1011 — Party Royale posters
    // chunk 1012 — Fungus King set
    // chunk 1013
    // chunk 1014 — BID_832_Lavish_TV630, Pickaxe_ID_653_LavishMale1H_SWKJB
    entries: [
      "00EEB0CEB7585E8C69F90EF8534CA428:gSddavzl1D9mSi3KgCoXjX3eb5Dg9Rqh2C1pt6rD5rk=",
      "1CFA91F4317CA2724E2AD9A098B2888B:op+720ix4L4JmxKqwXbOt+T5Xwqhcva7c6lETmEVCbY=",
      "22B8405FC3BE153C8148422C3F2D3A8A:d/ATMDztVZxwHLUCwOcJWP1/7oPKKGqbBWUBRNZ6dnM=",
      "2A12750AF48FB5468105F255DC537CC1:lKjAansupIjoXjT3/0vH9XeOzVp9S+fBGtyP90Gve60=",
      "687E53607C7004988B05C9EE1BA99AFD:jYmAGdz5vAvDRIhrcVdrcCNIPEmkJg8L1vWs/HZ5Kr0=",
      "8022BB6AFCA2733E261C32590EA86E9B:HzKZXV9sQfjsDuGuGRfpabHawomJhu82FeOaEQDg1lM=",
      "8A154454D5B98503B341742F927C2457:grJh5qYNlPy1eMO4+to3Moy+a6NCMnXyGSAFUKKWY5E=",
      "955C5EA2C28764221AF554097C5CE9E6:jzkT7NbAZpMlRIC/qnSOUAcAz6CXh00ZF3EK+GfWbGQ=",
      "95EE98AB79EAA4E2871EFA0E4BA9CD7E:LJCJ2kW7AQoni1spB+sLcir3NXBEE7zOC0JGKKhn0ZY=",
      "987329E3B70FEAD522EBF7435E5CA6DD:j4zyQQh25LYcjUO0HYDsBzmqLSXR5r98UKdC0xeTyHI=",
      "9E9072AA036FB1FF6B2AAD7BEFE7BF17:ORHgZOt4Zrtc8dLSx6jCsWZ3Z6AwPJiSiFAkZRMK3kM=",
      "BE20AAF89FE897368E52AAA193DEEB53:jHRZho9v4IKzFzk51RD0nAVFCZ27vIwcstPkdQeSupc=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "D24B0606E503B97BFEB8EF12C6F1340B:wCF6GzuxQSxUX9I6eFwGJL34gU7YEPTKrZOOL3sPL3o=",
      "ED088B11311A599D6225CE85545F019A:1NMRh4JMXRL9XW8Kb6zo4/F10dwLJC1+kPm6D6DudCE=",
    ],
    unknownChunks: 0,
  },
  {
    build: "18.00",
    // chunk 1000 — EID_MyEffort_BT5Z0
    // chunk 1001 — EID_Shindig_8W1AW
    // chunk 1002 — BID_837_Dragonfruit_0IZM3, Pickaxe_ID_664_DragonfruitMale1H_4BIXL, Wrap_391_Dragonfruit_YVN1M
    // chunk 1003 — Party Royale posters
    // chunk 1004
    // chunk 1005 — EID_SmallFry_KFFA1
    // chunk 1006 — EID_Comrade_6O5AK
    // chunk 1007 — EID_Downward_8GZUA
    // chunk 1008 — EID_Butter_1R26Q
    // chunk 1009 — BID_862_BigBucksBattleship_1JA5G
    // chunk 1010 — EID_Boomer_N2RQT
    // chunk 1011 — BID_827_AntiquePal_BL5ER, Pickaxe_ID_649_AntiquePalMale1H_GBT24
    // chunk 1012 — Emoji_S18_ClashV_I1DF9, Glider_ID_317_VertigoMale_E3F81, Pickaxe_ID_668_ClashVMale1H_5TA18, Trails_ID_102_HightowerVertigo_G63FW
    // chunk 1013 — Fungus King set
    // chunk 1014 — Balenciaga Set
    // chunk 1015 — BID_832_Lavish_TV630, Pickaxe_ID_653_LavishMale1H_SWKJB
    entries: [
      "00EEB0CEB7585E8C69F90EF8534CA428:gSddavzl1D9mSi3KgCoXjX3eb5Dg9Rqh2C1pt6rD5rk=",
      "1CFA91F4317CA2724E2AD9A098B2888B:op+720ix4L4JmxKqwXbOt+T5Xwqhcva7c6lETmEVCbY=",
      "22B8405FC3BE153C8148422C3F2D3A8A:d/ATMDztVZxwHLUCwOcJWP1/7oPKKGqbBWUBRNZ6dnM=",
      "2A12750AF48FB5468105F255DC537CC1:lKjAansupIjoXjT3/0vH9XeOzVp9S+fBGtyP90Gve60=",
      "4F365EB12B55EB9A6BDD99DFC3D02E61:JFApzAook6DV1rLMngEwoo0pprP17X6gjpNc79NQ43A=",
      "687E53607C7004988B05C9EE1BA99AFD:jYmAGdz5vAvDRIhrcVdrcCNIPEmkJg8L1vWs/HZ5Kr0=",
      "89D641BBEFFD9A227200861A01807ECF:rXDTm9JS6HhLBHIDXPRRF/eERp1DkUhV46QPxevqMWA=",
      "8A154454D5B98503B341742F927C2457:grJh5qYNlPy1eMO4+to3Moy+a6NCMnXyGSAFUKKWY5E=",
      "95EE98AB79EAA4E2871EFA0E4BA9CD7E:LJCJ2kW7AQoni1spB+sLcir3NXBEE7zOC0JGKKhn0ZY=",
      "96FD474CBA52137DC5ABF658BE17C792:ZLWvbUR7Xow1GUNjC9Mxg7DHVoJAnBr4b9gSzmyFcxU=",
      "987329E3B70FEAD522EBF7435E5CA6DD:j4zyQQh25LYcjUO0HYDsBzmqLSXR5r98UKdC0xeTyHI=",
      "9E9072AA036FB1FF6B2AAD7BEFE7BF17:ORHgZOt4Zrtc8dLSx6jCsWZ3Z6AwPJiSiFAkZRMK3kM=",
      "C76299772B1BE272260BF3396F83FC1E:uiBDMtwYhdxktbqTrhYkzEZErlBp5gBtkLM+QFDouT4=",
      "CB34283BE466D2421549051C400A9E52:rTmyRzx7oSiBWRv52itbCbAFlLIy7W6dZoDcfyTMmyo=",
      "E4D8D083C49828F6BF310ECA74A84F98:NxjtZXHe49xC1zUVs+XKjHbeic3prkFOWmwkaQ1vOFw=",
      "ED088B11311A599D6225CE85545F019A:1NMRh4JMXRL9XW8Kb6zo4/F10dwLJC1+kPm6D6DudCE=",
    ],
    unknownChunks: 0,
  },
  {
    build: "18.10",
    // chunk 1000 — EID_MyEffort_BT5Z0
    // chunk 1001
    // chunk 1002 — EID_Comrade_6O5AK
    // chunk 1003
    // chunk 1004 — BID_862_BigBucksBattleship_1JA5G
    // chunk 1005
    // chunk 1006 — BID_867_CritterFrenzy_3VYKQ, Pickaxe_ID_676_CritterFrenzyMale_B21OE, Wrap_404_CritterFrenzy_SNXC0
    // chunk 1007 — Emoji_S18_ClashV_I1DF9, Glider_ID_317_VertigoMale_E3F81, Pickaxe_ID_668_ClashVMale1H_5TA18, Trails_ID_102_HightowerVertigo_G63FW
    // chunk 1008
    // chunk 1009 — BID_863_Tomcat_5V2TZ, Glider_ID_318_Wombat_1MQMN, Pickaxe_ID_680_TomcatMale_LOSMX
    // chunk 1010 — Balenciaga Set
    // chunk 1011 — EID_DuckTeacher_9IPLU
    entries: [
      "00EEB0CEB7585E8C69F90EF8534CA428:gSddavzl1D9mSi3KgCoXjX3eb5Dg9Rqh2C1pt6rD5rk=",
      "4F365EB12B55EB9A6BDD99DFC3D02E61:JFApzAook6DV1rLMngEwoo0pprP17X6gjpNc79NQ43A=",
      "89D641BBEFFD9A227200861A01807ECF:rXDTm9JS6HhLBHIDXPRRF/eERp1DkUhV46QPxevqMWA=",
      "8AB2A1D47937F30D49879F4043164045:Mwur5341qGGuZkJb6aGqo7oPYGS5RIaLu3lgf5n6eRg=",
      "96FD474CBA52137DC5ABF658BE17C792:ZLWvbUR7Xow1GUNjC9Mxg7DHVoJAnBr4b9gSzmyFcxU=",
      "A7FAF0883F9147F93079F3A40413A83C:+wNde9ex5o3zvdjqgJUGhqcxmecYiQW3W1QuO00NUbc=",
      "C23FA9BDE9342B508B8AABBEEA6699A2:3mRtSSu9PTBlC3NpGAQcFent660Ptni4HbGX+Zj1KIA=",
      "C76299772B1BE272260BF3396F83FC1E:uiBDMtwYhdxktbqTrhYkzEZErlBp5gBtkLM+QFDouT4=",
      "D24B0606E503B97BFEB8EF12C6F1340B:wCF6GzuxQSxUX9I6eFwGJL34gU7YEPTKrZOOL3sPL3o=",
      "D517F2A448CCB9B47E5004894BC62ACF:qOdQUR91sysqDRELOgz/YVZ7Piae8hqcrnYW90fXtvU=",
      "E4D8D083C49828F6BF310ECA74A84F98:NxjtZXHe49xC1zUVs+XKjHbeic3prkFOWmwkaQ1vOFw=",
      "F9AF8CDE150D2D1E65B64710D70C23A7:3SpHToTu2E//Qe8Dhu4I3kG5fLqEemMiL+2NxRVKdOc=",
    ],
    unknownChunks: 0,
  },
  {
    build: "18.20",
    // chunk 1000
    // chunk 1001 — Universal Monsters Set
    // chunk 1002 — S.T.A.R.S Team Set
    // chunk 1003 — BID_877_BistroAstronaut_LWL45, BID_878_BistroSpooky_VPF4T, Glider_ID_319_BistroAstronautFemale_A4839, MusicPack_106_Bistro_DQZH0, Pickaxe_ID_682_BistroAstronautFemale_A3MD2
    // chunk 1004 — EID_ChickenLeg_TDJ0O
    // chunk 1005 — Batman Who Laughs Set
    // chunk 1006 — BID_867_CritterFrenzy_3VYKQ, Pickaxe_ID_676_CritterFrenzyMale_B21OE, Wrap_404_CritterFrenzy_SNXC0
    // chunk 1007 — BID_863_Tomcat_5V2TZ, Glider_ID_318_Wombat_1MQMN, Pickaxe_ID_680_TomcatMale_LOSMX
    // chunk 1008 — CID_A_223_Athena_Commando_M_Glitz_MJ5WQ
    // chunk 1009 — BID_875_SunriseCastle_91J3L, BID_876_SunrisePalace_7JPK6, EID_Sunrise_RPZ6M, Glider_ID_324_SunriseCastleMale_2R4Q3, LSID_358_Sunrise_1Q2KG, Pickaxe_ID_693_SunriseCastle1H_5XE1U, Pickaxe_ID_694_SunrisePalace1H_SDI6M
    entries: [
      "0E32ED911D1D1D67115812FB22317555:4qQbE3qtFL+oTEzvxYIwl2H6AsG7z1/3zNO9JEdHOd8=",
      "2E5F91AEF58F310AE2044EA39C43BB81:pNy1GtfVzymqacOqXRY14EZEvI5ZSVD5AFxlhxXC5qk=",
      "545B9777127F4BE242F802C627356B7E:RNI/KvLEXcGoGnk3/AKaYbyJmXMtQl9Zmvl8ErePB4g=",
      "88FA70760D757D80F661FA53B4762EC2:7OtV76cpyOq9dNeM5PVD8TOdRcPx1K3weEPXzlCugu0=",
      "8CB3CD29BF1611B7CA90D1C635859415:s7gVGQuQz2CDwqNda6dXQRqH9mpV6NUFu1zaoDihQYU=",
      "BE2C3EF59AB81D812AF5B8153325998F:W7NoICLZt9L2d7XZ5dT9gtI80MyOizk7uA9LtwA/Edw=",
      "C23FA9BDE9342B508B8AABBEEA6699A2:3mRtSSu9PTBlC3NpGAQcFent660Ptni4HbGX+Zj1KIA=",
      "D517F2A448CCB9B47E5004894BC62ACF:qOdQUR91sysqDRELOgz/YVZ7Piae8hqcrnYW90fXtvU=",
      "DD07D332EE51C9C9585F5249FD62A45A:8Fv7jA8ISZ3iOlNCeaeeGh9rmRV6QvL7sbsx5wYTvnc=",
      "F044853E82632E827ED91FB4AFBD28DF:LH1pXQ13KEoYfxxylALn8jaS0t/7IrVRVmO8UXieaVU=",
    ],
    unknownChunks: 0,
  },
  {
    build: "18.21",
    // chunk 1000
    // chunk 1001 — Universal Monsters Set
    // chunk 1002 — S.T.A.R.S Team Set
    // chunk 1003 — EID_ChickenLeg_TDJ0O
    // chunk 1004 — Batman Who Laughs Set
    // chunk 1005 — BID_867_CritterFrenzy_3VYKQ, Pickaxe_ID_676_CritterFrenzyMale_B21OE, Wrap_404_CritterFrenzy_SNXC0
    // chunk 1006 — BID_863_Tomcat_5V2TZ, Glider_ID_318_Wombat_1MQMN, Pickaxe_ID_680_TomcatMale_LOSMX
    // chunk 1007 — CID_A_223_Athena_Commando_M_Glitz_MJ5WQ
    // chunk 1008 — BID_875_SunriseCastle_91J3L, BID_876_SunrisePalace_7JPK6, EID_Sunrise_RPZ6M, Glider_ID_324_SunriseCastleMale_2R4Q3, LSID_358_Sunrise_1Q2KG, Pickaxe_ID_693_SunriseCastle1H_5XE1U, Pickaxe_ID_694_SunrisePalace1H_SDI6M
    entries: [
      "0E32ED911D1D1D67115812FB22317555:4qQbE3qtFL+oTEzvxYIwl2H6AsG7z1/3zNO9JEdHOd8=",
      "2E5F91AEF58F310AE2044EA39C43BB81:pNy1GtfVzymqacOqXRY14EZEvI5ZSVD5AFxlhxXC5qk=",
      "545B9777127F4BE242F802C627356B7E:RNI/KvLEXcGoGnk3/AKaYbyJmXMtQl9Zmvl8ErePB4g=",
      "8CB3CD29BF1611B7CA90D1C635859415:s7gVGQuQz2CDwqNda6dXQRqH9mpV6NUFu1zaoDihQYU=",
      "BE2C3EF59AB81D812AF5B8153325998F:W7NoICLZt9L2d7XZ5dT9gtI80MyOizk7uA9LtwA/Edw=",
      "C23FA9BDE9342B508B8AABBEEA6699A2:3mRtSSu9PTBlC3NpGAQcFent660Ptni4HbGX+Zj1KIA=",
      "D517F2A448CCB9B47E5004894BC62ACF:qOdQUR91sysqDRELOgz/YVZ7Piae8hqcrnYW90fXtvU=",
      "DD07D332EE51C9C9585F5249FD62A45A:8Fv7jA8ISZ3iOlNCeaeeGh9rmRV6QvL7sbsx5wYTvnc=",
      "F044853E82632E827ED91FB4AFBD28DF:LH1pXQ13KEoYfxxylALn8jaS0t/7IrVRVmO8UXieaVU=",
    ],
    unknownChunks: 0,
  },
  {
    build: "18.30",
    // chunk 1000
    // chunk 1001
    // chunk 1002
    // chunk 1003 — BID_896_GrasshopperMale_BRT10, CID_A_234_Athena_Commando_M_Grasshopper_A_57ARK, CID_A_235_Athena_Commando_M_Grasshopper_B_RHQUY, CID_A_236_Athena_Commando_M_Grasshopper_C_47TZ8, CID_A_237_Athena_Commando_M_Grasshopper_D_5OEIK, CID_A_238_Athena_Commando_M_Grasshopper_E_Q14K1, CID_A_239_Athena_Commando_F_Grasshopper_H6LB7, CID_A_240_Athena_Commando_F_Grasshopper_B_9RSI1, CID_A_241_Athena_Commando_F_Grasshopper_C_QGV1I, CID_A_242_Athena_Commando_F_Grasshopper_D_EIQ7X, CID_A_243_Athena_Commando_F_Grasshopper_E_L6I24, EID_Grasshopper_8D51K, Pickaxe_ID_696_Grasshopper_Male_24OGH
    // chunk 1004 — Universal Monsters Set
    // chunk 1005 — EID_Ashes_MYQ8O, LSID_364_Ashes_0XBPK
    // chunk 1006 — S.T.A.R.S Team Set
    // chunk 1007
    // chunk 1008
    // chunk 1009 — BID_890_UproarBraids_EF68P, MusicPack_112_Uproar_59WME, Pickaxe_ID_699_UproarBraidsFemale_LY5GM, SPID_325_UproarGraffiti_QFE4O
    // chunk 1010 — EID_ChickenLeg_TDJ0O
    // chunk 1011 — CID_A_232_Athena_Commando_F_CritterStreak_YILHR
    // chunk 1012 — Batman Who Laughs Set
    // chunk 1013 — BID_867_CritterFrenzy_3VYKQ, Pickaxe_ID_676_CritterFrenzyMale_B21OE, Wrap_404_CritterFrenzy_SNXC0
    // chunk 1014 — BID_863_Tomcat_5V2TZ, Glider_ID_318_Wombat_1MQMN, Pickaxe_ID_680_TomcatMale_LOSMX
    // chunk 1015 — CID_A_223_Athena_Commando_M_Glitz_MJ5WQ
    // chunk 1016 — BID_875_SunriseCastle_91J3L, BID_876_SunrisePalace_7JPK6, EID_Sunrise_RPZ6M, Glider_ID_324_SunriseCastleMale_2R4Q3, LSID_358_Sunrise_1Q2KG, Pickaxe_ID_693_SunriseCastle1H_5XE1U, Pickaxe_ID_694_SunrisePalace1H_SDI6M
    entries: [
      "00BD73648F7CD05EDE0B2D4C33B499BD:0D3XSX1KGIR/UWBELcxKxJp06xbU96TetFY2Rz9R614=",
      "0DE6839DE97A78F987D7A34D644BB3AD:ZKZ1+Eb+7CpzfLHMqihYVN9+gVQobqBYQW5mh8I1KpA=",
      "0E32ED911D1D1D67115812FB22317555:4qQbE3qtFL+oTEzvxYIwl2H6AsG7z1/3zNO9JEdHOd8=",
      "21D9E3FA446D32EE85025841557C1E4C:KBL9ZqzocmLvcq5k3mwTCeoeeVfJdw9wjuQacUrg50w=",
      "2E5F91AEF58F310AE2044EA39C43BB81:pNy1GtfVzymqacOqXRY14EZEvI5ZSVD5AFxlhxXC5qk=",
      "360CD59F6F7B68A441DDED9DB5FD13D7:G6pVAf/ul1HPYh6s2M1l8G4hn62jdwkcbegeLoxL7Y0=",
      "545B9777127F4BE242F802C627356B7E:RNI/KvLEXcGoGnk3/AKaYbyJmXMtQl9Zmvl8ErePB4g=",
      "5E2A3EE7CE3884E31F58D83485D8B122:U++ePc5N62iMtEbjrJGSwNCaWeR6UoNMtWS85zJHwns=",
      "6537263AA4E53B6A7B7D4AE3DE12826C:6WOQR0kXJWBJ4miykyUSj/hcH4u5JTSFpBTwaIeIFxQ=",
      "72CC2893A6B672F3854F36629B770774:0BgQgKZRRuPFEoqn7CxZVhLBOfpCE3qLKGQlZc+SA80=",
      "8CB3CD29BF1611B7CA90D1C635859415:s7gVGQuQz2CDwqNda6dXQRqH9mpV6NUFu1zaoDihQYU=",
      "AC22C5B2B654FE15BDCC8B664D033140:zE2ddgoXrJ7X0UEkphUtys0CeoTzIDpAZ58beqOkx4M=",
      "BE2C3EF59AB81D812AF5B8153325998F:W7NoICLZt9L2d7XZ5dT9gtI80MyOizk7uA9LtwA/Edw=",
      "C23FA9BDE9342B508B8AABBEEA6699A2:3mRtSSu9PTBlC3NpGAQcFent660Ptni4HbGX+Zj1KIA=",
      "D517F2A448CCB9B47E5004894BC62ACF:qOdQUR91sysqDRELOgz/YVZ7Piae8hqcrnYW90fXtvU=",
      "DD07D332EE51C9C9585F5249FD62A45A:8Fv7jA8ISZ3iOlNCeaeeGh9rmRV6QvL7sbsx5wYTvnc=",
      "F044853E82632E827ED91FB4AFBD28DF:LH1pXQ13KEoYfxxylALn8jaS0t/7IrVRVmO8UXieaVU=",
    ],
    unknownChunks: 0,
  },
  {
    build: "18.40",
    // chunk 1000
    // chunk 1001 — LSID_367_Paperbag_3WGO8
    // chunk 1002 — EID_Ashes_MYQ8O, LSID_364_Ashes_0XBPK
    // chunk 1003
    // chunk 1004 — EID_Eerie_8WGYK
    // chunk 1005 — BID_906_GrandeurMale_4JIZO, LSID_372_Grandeur_UOK4E
    // chunk 1006
    // chunk 1007 — Chapter 2 End event
    // chunk 1008
    // chunk 1009
    // chunk 1010 — LSID_374_GuavaKey_IY0H9
    // chunk 1011
    // chunk 1012 — EID_Haste1_T98Z9, Season18_Haste_TrickShotStyle1_Schedule
    // chunk 1013 — BID_907_Nucleus_J147F, Glider_ID_327_NucleusMale_55HFK, LSID_373_Nucleus_TZ5C1, Pickaxe_ID_708_NucleusMale_72W2J
    // chunk 1014
    // chunk 1015
    entries: [
      "053E7EE2FE8B6EB117A01D1E0AF82AD1:SDqBD0e/4fAyf3WCPqwUQD/gDhMWPtbdTZt5j/p3M2A=",
      "23280A6FC0902B6420BB82522AE16D2C:C7o6m2vJJY+XWKd0t1YLBPVLYCMgNbt10d/itx5Wjnc=",
      "360CD59F6F7B68A441DDED9DB5FD13D7:G6pVAf/ul1HPYh6s2M1l8G4hn62jdwkcbegeLoxL7Y0=",
      "60CE6E28E6993C1DC1C58E839E7A7284:ZlOTwn6YbAK9HetjsiQo0AS1jwJQnLJY7NkR5i7o2/g=",
      "6DEBEC4266A3BC248F8A8FD4B76878BF:wjCAJ9VaThgTfbvUetCEWQFii5GmdfPwFCvxLv5ip/g=",
      "6EA156BE3D18E1D649D7D4B3F8C0FACA:qAKD9oM8u4IvUcKbReHTMaLg7GtHLBcnmz8++vwwB6o=",
      "87F01091E4DA4FE3FFC9AD92A20A8DCE:p+5QvlQEV5QW2QQrIWrDnnthhNN9V0wXK+Zdmiw71u0=",
      "9972857939D69D9799D6800D0D70ACE4:J5NKMyEoVZ2zBlCiTGN65eKAAHStaOO+bVGbJfsFI/k=",
      "A062151202F2D5FCAD103D17B9300CE2:JiiR0xFNh20CRLDWN/tfjaeoo2ybApd1hQB364/iuTc=",
      "A3254C97AE656A9B7301225E06E6B58F:tnv0g+8KyEy6IGYAl1ssmNI0uYT2fEP2twZkRnbIhbY=",
      "A92DE306E5174C82739D774151D7B661:RF9sTh7l2tp+ypCb/Lp3WeMfBExvk2LSUbim04xsCJo=",
      "B3A4B83DA3274522D4B9F117DCF9A0B3:y5n7vfr0uucr+psZzb2F3g45pWUsv3i3j/M6bl78Z9A=",
      "BA490514EFDA436A2679E381BD558AA3:3KBKxBOi/52H0feJ/ijKxRHk+lF1zID0uIpjd0T7/Bc=",
      "D14FDB2BB2FB7746797F25470913BFF1:CQDgIxcNnAoUboQnjafZAYvV7UqX+NefGTXFd3m+oFc=",
      "D24667CC40ED6564CE26A31E63E327BA:OnghWyLG/IQEx45PtmEcmqAHuViWUsTSDQ31EgRhyZM=",
      "F51F080981F8DC32B09FC3C62A977363:NqX2i8P3ayVe/mUk8aAqzUg5tvMEDWt1URv6xc4fUkY=",
    ],
    unknownChunks: 0,
  },
  {
    build: "19.00",
    // chunk 1000 — BID_917_RustyBoltMale_1DGTV, BID_918_RustyBoltFemale_J4JW1, EID_RustyBolt_ZMR13, Glider_ID_333_RustyBolt_13IXR, Pickaxe_ID_719_RustyBoltFemale_0VJ7J, Pickaxe_ID_720_RustyBoltMale_UZ5E5, Pickaxe_ID_721_RustyBoltSliceMale_V3A4N, SPID_333_RustyBoltCreature_ZGF9S
    // chunk 1001 — LSID_367_Paperbag_3WGO8
    // chunk 1002
    // chunk 1003 — EID_Ashes_MYQ8O, LSID_364_Ashes_0XBPK
    // chunk 1005 — EID_Eerie_8WGYK
    // chunk 1006 — BID_906_GrandeurMale_4JIZO, LSID_372_Grandeur_UOK4E
    // chunk 1007
    // chunk 1008
    // chunk 1009 — LSID_374_GuavaKey_IY0H9
    // chunk 1010 — EID_Haste1_T98Z9, Season18_Haste_TrickShotStyle1_Schedule
    // chunk 1011 — BID_907_Nucleus_J147F, Glider_ID_327_NucleusMale_55HFK, LSID_373_Nucleus_TZ5C1, Pickaxe_ID_708_NucleusMale_72W2J
    // chunk 1012
    // chunk 1013
    entries: [
      "0882DAEC4F7823551C4955BA25B8AAC4:kGljCDpbMnCIfeo0YBLpBKDhX6nLlCaZRe62mSYSPTs=",
      "23280A6FC0902B6420BB82522AE16D2C:C7o6m2vJJY+XWKd0t1YLBPVLYCMgNbt10d/itx5Wjnc=",
      "2648ACDF6B7E55495928F2319101BB8A:tKha+iiFKUamRIWCxq0gOtbN/G1B5J5eOIElAx9T3rc=",
      "360CD59F6F7B68A441DDED9DB5FD13D7:G6pVAf/ul1HPYh6s2M1l8G4hn62jdwkcbegeLoxL7Y0=",
      "6DEBEC4266A3BC248F8A8FD4B76878BF:wjCAJ9VaThgTfbvUetCEWQFii5GmdfPwFCvxLv5ip/g=",
      "6EA156BE3D18E1D649D7D4B3F8C0FACA:qAKD9oM8u4IvUcKbReHTMaLg7GtHLBcnmz8++vwwB6o=",
      "87F01091E4DA4FE3FFC9AD92A20A8DCE:p+5QvlQEV5QW2QQrIWrDnnthhNN9V0wXK+Zdmiw71u0=",
      "A062151202F2D5FCAD103D17B9300CE2:JiiR0xFNh20CRLDWN/tfjaeoo2ybApd1hQB364/iuTc=",
      "A92DE306E5174C82739D774151D7B661:RF9sTh7l2tp+ypCb/Lp3WeMfBExvk2LSUbim04xsCJo=",
      "BA490514EFDA436A2679E381BD558AA3:3KBKxBOi/52H0feJ/ijKxRHk+lF1zID0uIpjd0T7/Bc=",
      "D14FDB2BB2FB7746797F25470913BFF1:CQDgIxcNnAoUboQnjafZAYvV7UqX+NefGTXFd3m+oFc=",
      "D24667CC40ED6564CE26A31E63E327BA:OnghWyLG/IQEx45PtmEcmqAHuViWUsTSDQ31EgRhyZM=",
      "E66DF3CF1BFE84F0B1966967210DD6D9:DGLD/iFbdLvaiZnAfWrHIW5yJ5SfsQQyjeW2IBQe+zw=",
    ],
    unknownChunks: 2,
  },
  {
    build: "19.01",
    // chunk 1001 — BID_917_RustyBoltMale_1DGTV, BID_918_RustyBoltFemale_J4JW1, CID_A_294_Athena_Commando_F_RustyBolt_DB20X, CID_A_295_Athena_Commando_M_RustyBolt_FEHJ0, EID_RustyBolt_ZMR13, Glider_ID_333_RustyBolt_13IXR, Pickaxe_ID_719_RustyBoltFemale_0VJ7J, Pickaxe_ID_720_RustyBoltMale_UZ5E5, Pickaxe_ID_721_RustyBoltSliceMale_V3A4N, SPID_332_RustyBoltLogo_ZB1B0, SPID_333_RustyBoltCreature_ZGF9S
    // chunk 1004 — EID_Layers_BBZ49
    // chunk 1009 — EN_15PR_ShortNite_In-Game_Poster_512x512
    // chunk 1010 — Wrap_417_Guava_7J7EW, LSID_374_GuavaKey_IY0H9, LSID_375_GuavaEvent_9GXE3
    // chunk 1011 — BID_909_HasteMale_EPX5A, CID_A_269_Athena_Commando_F_HasteStreet_B563I, CID_A_270_Athena_Commando_M_HasteDouble_8GQHC, EID_Haste1_T98Z9, SPID_330_Haste_52NCD
    entries: [
      "0882DAEC4F7823551C4955BA25B8AAC4:kGljCDpbMnCIfeo0YBLpBKDhX6nLlCaZRe62mSYSPTs=",
      "42FEDE262B530BFDC25D9E6B8684D1B7:bXloLJVoSi2uTe72cpdsB8pAmUPKzmxwPC2GPhHFVhk=",
      "A062151202F2D5FCAD103D17B9300CE2:JiiR0xFNh20CRLDWN/tfjaeoo2ybApd1hQB364/iuTc=",
      "A92DE306E5174C82739D774151D7B661:RF9sTh7l2tp+ypCb/Lp3WeMfBExvk2LSUbim04xsCJo=",
      "BA490514EFDA436A2679E381BD558AA3:3KBKxBOi/52H0feJ/ijKxRHk+lF1zID0uIpjd0T7/Bc=",
    ],
    unknownChunks: 11,
  },
];

const BY_BUILD = new Map<string, BuildKeychain>(KEYCHAINS.map((k) => [k.build, k]));

/**
 * Keys for an exact build, or null.
 *
 * Deliberately exact. Chunk keys are per-build and do not carry forward — serving 8.00's keys to an
 * 8.10 client would hand it keys for chunks that build does not have, which is worse than serving
 * none because it looks like a decryption failure rather than a missing key.
 */
export function keychainForBuild(build: string): BuildKeychain | null {
  return BY_BUILD.get(build) ?? null;
}

/** `major.minor` in the archive's spelling, e.g. (7, 40) -> "7.40". */
export function buildString(major: number, minor: number): string {
  return `${major}.${String(minor).padStart(2, '0')}`;
}
