/* @flow */
const { execSync } = require(`child_process`)
const execa = require(`execa`)
const hostedGitInfo = require(`hosted-git-info`)
const fs = require(`fs-extra`)
const sysPath = require(`path`)
const report = require(`./reporter`)
const url = require(`url`)
const isValid = require(`is-valid-path`)
const existsSync = require(`fs-exists-cached`).sync
const { trackCli, trackError } = require(`gatsby-telemetry`)
const prompts = require(`prompts`)
const opn = require(`better-opn`)

const {
  getPackageManager,
  promptPackageManager,
} = require(`./util/configstore`)
const isTTY = require(`./util/is-tty`)
const spawn = (cmd: string, options: any) => {
  const [file, ...args] = cmd.split(/\s+/)
  return spawnWithArgs(file, args, options)
}
const spawnWithArgs = (file: string, args: string[], options: any) =>
  execa(file, args, { stdio: `inherit`, preferLocal: false, ...options })

// Checks the existence of yarn package and user preference if it exists
// We use yarnpkg instead of yarn to avoid conflict with Hadoop yarn
// Refer to https://github.com/yarnpkg/yarn/issues/673
const shouldUseYarn = async () => {
  try {
    execSync(`yarnpkg --version`, { stdio: `ignore` })

    let packageManager = getPackageManager()
    if (!packageManager) {
      // if package manager is not set:
      //  - prompt user to pick package manager if in interactive console
      //  - default to yarn if not in interactive console
      if (isTTY()) {
        packageManager = (await promptPackageManager()) || `yarn`
      } else {
        packageManager = `yarn`
      }
    }

    return packageManager === `yarn`
  } catch (e) {
    return false
  }
}

const isAlreadyGitRepository = async () => {
  try {
    return await spawn(`git rev-parse --is-inside-work-tree`, {
      stdio: `pipe`,
    }).then(output => output.stdout === `true`)
  } catch (err) {
    return false
  }
}

// Initialize newly cloned directory as a git repo
const gitInit = async rootPath => {
  report.info(`Initialising git in ${rootPath}`)

  return await spawn(`git init`, { cwd: rootPath })
}

// Create a .gitignore file if it is missing in the new directory
const maybeCreateGitIgnore = async rootPath => {
  if (existsSync(sysPath.join(rootPath, `.gitignore`))) {
    return
  }

  report.info(`Creating minimal .gitignore in ${rootPath}`)
  await fs.writeFile(
    sysPath.join(rootPath, `.gitignore`),
    `.cache\nnode_modules\npublic\n`
  )
}

// Create an initial git commit in the new directory
const createInitialGitCommit = async (rootPath, starterUrl) => {
  report.info(`Create initial git commit in ${rootPath}`)

  await spawn(`git add -A`, { cwd: rootPath })
  // use execSync instead of spawn to handle git clients using
  // pgp signatures (with password)
  execSync(`git commit -m "Initial commit from gatsby: (${starterUrl})"`, {
    cwd: rootPath,
  })
}

// Executes `npm install` or `yarn install` in rootPath.
const install = async rootPath => {
  const prevDir = process.cwd()

  report.info(`Installing packages...`)
  process.chdir(rootPath)

  try {
    if (await shouldUseYarn()) {
      await fs.remove(`package-lock.json`)
      await spawn(`yarnpkg`)
    } else {
      await fs.remove(`yarn.lock`)
      await spawn(`npm install`)
    }
  } finally {
    process.chdir(prevDir)
  }
}

const ignored = path => !/^\.(git|hg)$/.test(sysPath.basename(path))

// Copy starter from file system.
const copy = async (starterPath: string, rootPath: string) => {
  // Chmod with 755.
  // 493 = parseInt('755', 8)
  await fs.mkdirp(rootPath, { mode: 493 })

  if (!existsSync(starterPath)) {
    throw new Error(`starter ${starterPath} doesn't exist`)
  }

  if (starterPath === `.`) {
    throw new Error(
      `You can't create a starter from the existing directory. If you want to
      create a new site in the current directory, the trailing dot isn't
      necessary. If you want to create a new site from a local starter, run
      something like "gatsby new new-gatsby-site ../my-gatsby-starter"`
    )
  }

  report.info(`Creating new site from local starter: ${starterPath}`)

  report.log(`Copying local starter to ${rootPath} ...`)

  await fs.copy(starterPath, rootPath, { filter: ignored })

  report.success(`Created starter directory layout`)

  await install(rootPath)

  return true
}

// Clones starter from URI.
const clone = async (hostInfo: any, rootPath: string) => {
  let url
  // Let people use private repos accessed over SSH.
  if (hostInfo.getDefaultRepresentation() === `sshurl`) {
    url = hostInfo.ssh({ noCommittish: true })
    // Otherwise default to normal git syntax.
  } else {
    url = hostInfo.https({ noCommittish: true, noGitPlus: true })
  }

  const branch = hostInfo.committish ? [`-b`, hostInfo.committish] : []

  report.info(`Creating new site from git: ${url}`)

  const args = [`clone`, ...branch, url, rootPath, `--single-branch`].filter(
    arg => Boolean(arg)
  )

  await spawnWithArgs(`git`, args)

  report.success(`Created starter directory layout`)

  await fs.remove(sysPath.join(rootPath, `.git`))

  await install(rootPath)
  const isGit = await isAlreadyGitRepository()
  if (!isGit) await gitInit(rootPath)
  await maybeCreateGitIgnore(rootPath)
  if (!isGit) await createInitialGitCommit(rootPath, url)
}

const getPaths = async (starterPath: string, rootPath: string) => {
  let selectedOtherStarter = false

  // if no args are passed, prompt user for path and starter
  if (!starterPath && !rootPath) {
    const response = await prompts.prompt([
      {
        type: `text`,
        name: `path`,
        message: `What is your project called?`,
        initial: `my-gatsby-project`,
      },
      {
        type: `select`,
        name: `starter`,
        message: `What starter would you like to use?`,
        choices: [
          { title: `gatsby-starter-default`, value: `gatsby-starter-default` },
          {
            title: `gatsby-starter-hello-world`,
            value: `gatsby-starter-hello-world`,
          },
          { title: `gatsby-starter-blog`, value: `gatsby-starter-blog` },
          { title: `(Use a different starter)`, value: `different` },
        ],
        initial: 0,
      },
    ])
    // exit gracefully if responses aren't provided
    if (!response.starter || !response.path.trim()) {
      throw new Error(
        `Please mention both starter package and project name along with path(if its not in the root)`
      )
    }

    selectedOtherStarter = response.starter === `different`
    starterPath = `gatsbyjs/${response.starter}`
    rootPath = response.path
  }

  // set defaults if no root or starter has been set yet
  rootPath = rootPath || process.cwd()
  starterPath = starterPath || `gatsbyjs/gatsby-starter-default`

  return { starterPath, rootPath, selectedOtherStarter }
}

type InitOptions = {
  rootPath?: string,
}

/**
 * Main function that clones or copies the starter.
 */
module.exports = async (starter: string, options: InitOptions = {}) => {
  const { starterPath, rootPath, selectedOtherStarter } = await getPaths(
    starter,
    options.rootPath
  )

  const urlObject = url.parse(rootPath)

  if (selectedOtherStarter) {
    report.info(
      `Opening the starter library at https://gatsby.dev/starters?v=2...\nThe starter library has a variety of options for starters you can browse\n\nYou can then use the gatsby new command with the link to a repository of a starter you'd like to use, for example:\ngatsby new ${rootPath} https://github.com/gatsbyjs/gatsby-starter-default`
    )
    opn(`https://gatsby.dev/starters?v=2`)
    return
  }
  if (urlObject.protocol && urlObject.host) {
    trackError(`NEW_PROJECT_NAME_MISSING`)

    const isStarterAUrl =
      starter && !url.parse(starter).hostname && !url.parse(starter).protocol

    if (/gatsby-starter/gi.test(rootPath) && isStarterAUrl) {
      report.panic({
        id: `11610`,
        context: {
          starter,
          rootPath,
        },
      })
      return
    }
    report.panic({
      id: `11611`,
      context: {
        rootPath,
      },
    })
    return
  }

  if (!isValid(rootPath)) {
    report.panic({
      id: `11612`,
      context: {
        path: sysPath.resolve(rootPath),
      },
    })
    return
  }

  if (existsSync(sysPath.join(rootPath, `package.json`))) {
    trackError(`NEW_PROJECT_IS_NPM_PROJECT`)
    report.panic({
      id: `11613`,
      context: {
        rootPath,
      },
    })
    return
  }

  const hostedInfo = hostedGitInfo.fromUrl(starterPath)

  trackCli(`NEW_PROJECT`, {
    starterName: hostedInfo ? hostedInfo.shortcut() : `local:starter`,
  })
  if (hostedInfo) await clone(hostedInfo, rootPath)
  else await copy(starterPath, rootPath)
  trackCli(`NEW_PROJECT_END`)
}
