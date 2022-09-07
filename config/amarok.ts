interface AmarokConfig {
  [key: string]: {
    connextHandler: string
    domain: number
  }
}

const config: AmarokConfig = {
  hardhat: {
    connextHandler: '',
    domain: 0,
  },
  mainnet: {
    connextHandler: '',
    domain: 0,
  },
  goerli: {
    connextHandler: '0x6c9a905Ab3f4495E2b47f5cA131ab71281E0546e',
    domain: 3331,
  },
  rinkeby: {
    connextHandler: '0x4cAA6358a3d9d1906B5DABDE60A626AAfD80186F',
    domain: 1111,
  },
  mumbai: {
    connextHandler: '0x765cbd312ad84A791908000DF58d879e4eaf768b',
    domain: 9991,
  },
  evmosTestnet: {
    connextHandler: '0xd14d61FE8E1369957711C99a427d38A0d8Cc141C',
    domain: 4441,
  },
}

export default config
