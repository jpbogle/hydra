import * as anchor from "@project-serum/anchor";
import { Program, Provider } from "@project-serum/anchor";
import { getTokenAccount } from "@project-serum/common";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {
  PublicKey,
  Signer,
  SystemProgram, SYSVAR_RENT_PUBKEY,
  TransactionInstruction
} from "@solana/web3.js";
import {
  InstructionResult,
  sendInstructions
} from "@strata-foundation/spl-utils";
import { FanoutIDL } from "./generated/fanout";
export * from "./generated/fanout";

interface IInitializeFanoutArgs {
  payer?: PublicKey;
  /** The account to fanout on. Must either be owned by the program or it will be transfered to the program */
  account: PublicKey;
  /** The mint to create the fanout around. Should have no mint authority and freeze authority set to this program. 
  * 
  * If not provided, will create a mint for you and mint `supply` tokens to your account.
  */
  mint?: PublicKey;
  /** If `mint` not provided, params for the created mint */
  shares?: number;
}

interface IStakeArgs {
  payer?: PublicKey;
  fanout: PublicKey;
  /** Account holding the fanout mint tokens. **Default:** The associated token account of this wallet */
  voucherAccount?: PublicKey;
  /** Destination for fanout tokens. **Default:** The associated token account of this wallet */
  destination?: PublicKey;
}


interface IUnstakeArgs {
  /** The account that will receive the sol locked in the voucher acct. **Default:** This wallet */
  refund?: PublicKey;
  voucher: PublicKey;
}

interface DistributeV0 {
  payer?: PublicKey;
  /** The staking voucher to distribute funds to */
  voucher: PublicKey;
}

export class Fanout {
  program: Program<FanoutIDL>;
  provider: Provider;

  static ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

  static async init(
    provider: Provider,
    FanoutProgramId: PublicKey = Fanout.ID
  ): Promise<Fanout> {
    const FanoutIDLJson = await anchor.Program.fetchIdl(
      FanoutProgramId,
      provider
    );
    // @ts-ignore
    const Fanout = new anchor.Program(FanoutIDLJson!, FanoutProgramId, provider) as anchor.Program<FanoutIDL>;

    return new this(provider, Fanout);
  }

  constructor(
    provider: Provider,
    program: Program<FanoutIDL>,
  ) {
    this.provider = provider;
    this.program = program;
  }

  get programId() {
    return this.program.programId;
  }

  get rpc() {
    return this.program.rpc;
  }

  get instruction() {
    return this.program.instruction;
  }

  get wallet() {
    return this.provider.wallet;
  }

  get account() {
    return this.program.account;
  }

  get errors() {
    return this.program.idl.errors.reduce((acc, err) => {
      acc.set(err.code, `${err.name}: ${err.msg}`);
      return acc;
    }, new Map<number, string>());
  }

  sendInstructions(
    instructions: TransactionInstruction[],
    signers: Signer[],
    payer?: PublicKey
  ): Promise<string> {
    return sendInstructions(
      this.errors,
      this.provider,
      instructions,
      signers,
      payer
    );
  }

  static async fanoutKey(account: PublicKey, programId: PublicKey = Fanout.ID): Promise<[PublicKey, number]> {
    return await PublicKey.findProgramAddress(
      [Buffer.from("fanout", "utf-8"), account.toBuffer()],
      programId
    )
  }
  
  static async freezeAuthority(mint: PublicKey, programId: PublicKey = Fanout.ID): Promise<[PublicKey, number]> {
    return await PublicKey.findProgramAddress(
      [Buffer.from("freeze-authority", "utf-8"), mint.toBuffer()],
      programId
    )
  }

  static async accountOwner(account: PublicKey, programId: PublicKey = Fanout.ID): Promise<[PublicKey, number]> {
    return await PublicKey.findProgramAddress(
      [Buffer.from("account-owner", "utf-8"), account.toBuffer()],
      programId
    )
  }

  async initializeFanoutInstructions({
    payer = this.wallet.publicKey,
    account,
    mint,
    shares,
  }: IInitializeFanoutArgs): Promise<
    InstructionResult<{ fanout: PublicKey; }>
  > {
    const [fanout, bumpSeed] = await Fanout.fanoutKey(account);
    const [accountOwner, accountOwnerBumpSeed] = await Fanout.accountOwner(account);
    const instructions: TransactionInstruction[] = [];
    const signers = [];

    const tokenAccount = await getTokenAccount(this.provider, account);
    if (!tokenAccount.owner.equals(accountOwner)) {
      instructions.push(Token.createSetAuthorityInstruction(
        TOKEN_PROGRAM_ID,
        account,
        accountOwner,
        'AccountOwner',
        tokenAccount.owner,
        []
      ));
    }

    if (!mint) {
      const mintKeypair = anchor.web3.Keypair.generate();
      mint = mintKeypair.publicKey;
      const [freezeAuthority, freezeAuthorityBumpSeed] = await Fanout.freezeAuthority(mint);
      signers.push(mintKeypair);

      const destAcct = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        this.wallet.publicKey,
        true
      );
  
      instructions.push(
        ...[
          // Create the new mint
          SystemProgram.createAccount({
            fromPubkey: this.wallet.publicKey,
            newAccountPubkey: mintKeypair.publicKey,
            space: 82,
            lamports:
              await this.provider.connection.getMinimumBalanceForRentExemption(
                82
              ),
            programId: TOKEN_PROGRAM_ID,
          }),
          Token.createInitMintInstruction(
            TOKEN_PROGRAM_ID,
            mintKeypair.publicKey,
            0,
            this.wallet.publicKey,
            freezeAuthority
          ),
          // Create an ata to receive tokens for this mint
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mint,
            destAcct,
            this.wallet.publicKey,
            payer
          ),
          // Mint some tokens to ourself
          Token.createMintToInstruction(
            TOKEN_PROGRAM_ID,
            mintKeypair.publicKey,
            destAcct,
            this.wallet.publicKey,
            [],
            shares!
          ),
          // Remove mint authority
          Token.createSetAuthorityInstruction(
            TOKEN_PROGRAM_ID,
            mint,
            null,
            'MintTokens',
            this.wallet.publicKey,
            []
          )
        ]
      );
    }
    
    const [freezeAuthority, freezeAuthorityBumpSeed] = await Fanout.freezeAuthority(mint);

    instructions.push(await this.instruction.initializeFanoutV0({
      bumpSeed,
      freezeAuthorityBumpSeed,
      accountOwnerBumpSeed
    }, {
      accounts: {
        payer,
        fanout,
        mint,
        account,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY
      }
    }));

    return {
      output: {
        fanout
      },
      instructions,
      signers,
    };
  }

  async initializeFanout(args: IInitializeFanoutArgs): Promise<{ fanout: PublicKey}> {
    const { instructions, signers, output } = await this.initializeFanoutInstructions(args);

    await this.sendInstructions(instructions, signers, args.payer);

    return output
  }
}
