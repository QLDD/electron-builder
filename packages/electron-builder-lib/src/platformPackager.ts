import BluebirdPromise from "bluebird-lst"
import { Arch, asArray, AsyncTaskManager, debug, DebugLogger, executeAppBuilder, getArchSuffix, InvalidConfigurationError, isEmptyOrSpaces, log, deepAssign } from "builder-util"
import { PackageBuilder } from "builder-util/out/api"
import { statOrNull, unlinkIfExists } from "builder-util/out/fs"
import { orIfFileNotExist } from "builder-util/out/promise"
import { readdir, rename } from "fs-extra-p"
import { Lazy } from "lazy-val"
import { Minimatch } from "minimatch"
import * as path from "path"
import { AppInfo } from "./appInfo"
import { checkFileInArchive } from "./asar/asarFileChecker"
import { AsarPackager } from "./asar/asarUtil"
import { CompressionLevel, Platform, Target, TargetSpecificOptions } from "./core"
import { copyFiles, FileMatcher, getFileMatchers, getMainFileMatchers } from "./fileMatcher"
import { createTransformer, isElectronCompileUsed } from "./fileTransformer"
import { AfterPackContext, AsarOptions, Configuration, FileAssociation, PlatformSpecificBuildOptions } from "./index"
import { Packager } from "./packager"
import { unpackElectron, unpackMuon } from "./packager/dirPackager"
import { PackagerOptions } from "./packagerApi"
import { copyAppFiles } from "./util/appFileCopier"
import { computeFileSets, ELECTRON_COMPILE_SHIM_FILENAME } from "./util/AppFileCopierHelper"
import { AsarIntegrity, computeData } from "./asar/integrity"

export abstract class PlatformPackager<DC extends PlatformSpecificBuildOptions> implements PackageBuilder {
  get packagerOptions(): PackagerOptions {
    return this.info.options
  }

  get buildResourcesDir(): string {
    return this.info.buildResourcesDir
  }

  get projectDir(): string {
    return this.info.projectDir
  }

  get config(): Configuration {
    return this.info.config
  }

  readonly platformSpecificBuildOptions: DC

  get resourceList(): Promise<Array<string>> {
    return this._resourceList.value
  }

  private readonly _resourceList = new Lazy<Array<string>>(() => orIfFileNotExist(readdir(this.info.buildResourcesDir), []))

  readonly appInfo: AppInfo

  protected constructor(readonly info: Packager, readonly platform: Platform) {
    this.platformSpecificBuildOptions = PlatformPackager.normalizePlatformSpecificBuildOptions((this.config as any)[platform.buildConfigurationKey])
    this.appInfo = this.prepareAppInfo(info.appInfo)
  }

  get compression(): CompressionLevel {
    const compression = this.platformSpecificBuildOptions.compression
    // explicitly set to null - request to use default value instead of parent (in the config)
    if (compression === null) {
      return "normal"
    }
    return compression || this.config.compression || "normal"
  }

  get debugLogger(): DebugLogger {
    return this.info.debugLogger
  }

  abstract get defaultTarget(): Array<string>

  protected prepareAppInfo(appInfo: AppInfo) {
    return appInfo
  }

  private static normalizePlatformSpecificBuildOptions(options: any | null | undefined): any {
    return options == null ? Object.create(null) : options
  }

  abstract createTargets(targets: Array<string>, mapper: (name: string, factory: (outDir: string) => Target) => void): void

  protected getCscPassword(): string {
    const password = this.doGetCscPassword()
    if (isEmptyOrSpaces(password)) {
      log.info({reason: "CSC_KEY_PASSWORD is not defined"}, "empty password will be used for code signing")
      return ""
    }
    else {
      return password!.trim()
    }
  }

  protected getCscLink(envName: string = "CSC_LINK"): string | null | undefined {
    // allow to specify as empty string
    return chooseNotNull(chooseNotNull(this.info.config.cscLink, this.platformSpecificBuildOptions.cscLink), process.env[envName])
  }

  protected doGetCscPassword(): string | null | undefined {
    // allow to specify as empty string
    return chooseNotNull(chooseNotNull(this.info.config.cscKeyPassword, this.platformSpecificBuildOptions.cscKeyPassword), process.env.CSC_KEY_PASSWORD)
  }

  protected computeAppOutDir(outDir: string, arch: Arch): string {
    return this.packagerOptions.prepackaged || path.join(outDir, `${this.platform.buildConfigurationKey}${getArchSuffix(arch)}${this.platform === Platform.MAC ? "" : "-unpacked"}`)
  }

  dispatchArtifactCreated(file: string, target: Target | null, arch: Arch | null, safeArtifactName?: string | null) {
    this.info.dispatchArtifactCreated({
      file, safeArtifactName, target, arch,
      packager: this,
    })
  }

  async pack(outDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): Promise<any> {
    const appOutDir = this.computeAppOutDir(outDir, arch)
    await this.doPack(outDir, appOutDir, this.platform.nodeName, arch, this.platformSpecificBuildOptions, targets)
    this.packageInDistributableFormat(appOutDir, arch, targets, taskManager)
  }

  protected packageInDistributableFormat(appOutDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): void {
    taskManager.addTask(
      BluebirdPromise.map(targets, it => it.isAsyncSupported ? it.build(appOutDir, arch) : null)
        .then(() => BluebirdPromise.each(targets, it => it.isAsyncSupported ? null : it.build(appOutDir, arch)))
    )
  }

  private getExtraFileMatchers(isResources: boolean, appOutDir: string, macroExpander: (pattern: string) => string, customBuildOptions: DC): Array<FileMatcher> | null {
    const base = isResources ? this.getResourcesDir(appOutDir) : (this.platform === Platform.MAC ? path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents") : appOutDir)
    return getFileMatchers(this.config, isResources ? "extraResources" : "extraFiles", this.projectDir, base, macroExpander, customBuildOptions)
  }

  get electronDistMacOsAppName() {
    return this.config.muonVersion == null ? "Electron.app" : "Brave.app"
  }

  get electronDistExecutableName() {
    return this.config.muonVersion == null ? "electron" : "brave"
  }

  get electronDistMacOsExecutableName() {
    return this.config.muonVersion == null ? "Electron" : "Brave"
  }

  protected async doPack(outDir: string, appOutDir: string, platformName: string, arch: Arch, platformSpecificBuildOptions: DC, targets: Array<Target>) {
    if (this.packagerOptions.prepackaged != null) {
      return
    }

    const asarOptions = await this.computeAsarOptions(platformSpecificBuildOptions)
    const macroExpander = (it: string) => this.expandMacro(it, arch == null ? null : Arch[arch], {"/*": "{,/**/*}"})

    const resourcesPath = this.platform === Platform.MAC ? path.join(appOutDir, this.electronDistMacOsAppName, "Contents", "Resources") : path.join(appOutDir, "resources")

    const muonVersion = this.config.muonVersion
    const isElectron = muonVersion == null
    const config = this.config
    log.info({
      platform: platformName,
      arch: Arch[arch], [isElectron ? `electron` : `muon`]: isElectron ? config.electronVersion!! : muonVersion!!,
      appOutDir: log.filePath(appOutDir),
    }, `packaging`)

    if (this.info.isPrepackedAppAsar) {
      await unpackElectron(this, appOutDir, platformName, Arch[arch], config.electronVersion!)
    }
    else {
      await (isElectron ? unpackElectron(this, appOutDir, platformName, Arch[arch], config.electronVersion!) : unpackMuon(this, appOutDir, platformName, Arch[arch], muonVersion!))
    }

    const excludePatterns: Array<Minimatch> = []

    const computeParsedPatterns = (patterns: Array<FileMatcher> | null) => {
      if (patterns != null) {
        for (const pattern of patterns) {
          pattern.computeParsedPatterns(excludePatterns, this.info.projectDir)
        }
      }
    }

    const extraResourceMatchers = this.getExtraFileMatchers(true, appOutDir, macroExpander, platformSpecificBuildOptions)
    computeParsedPatterns(extraResourceMatchers)
    const extraFileMatchers = this.getExtraFileMatchers(false, appOutDir, macroExpander, platformSpecificBuildOptions)
    computeParsedPatterns(extraFileMatchers)

    const packContext: AfterPackContext = {
      appOutDir, outDir, arch, targets,
      packager: this,
      electronPlatformName: platformName,
    }

    const taskManager = new AsyncTaskManager(this.info.cancellationToken)

    this.copyAppFiles(taskManager, asarOptions, resourcesPath, outDir, platformSpecificBuildOptions, excludePatterns, macroExpander)

    taskManager.addTask(unlinkIfExists(path.join(resourcesPath, "default_app.asar")))
    taskManager.addTask(unlinkIfExists(path.join(appOutDir, "version")))
    taskManager.addTask(this.postInitApp(packContext))
    if (this.platform !== Platform.MAC) {
      taskManager.addTask(rename(path.join(appOutDir, "LICENSE"), path.join(appOutDir, "LICENSE.electron.txt")).catch(() => {/* ignore */}))
    }

    await taskManager.awaitTasks()
    await this.beforeCopyExtraFiles(appOutDir, asarOptions == null ? null : await computeData(resourcesPath, asarOptions.externalAllowed ? {externalAllowed: true} : null))
    await BluebirdPromise.each([extraResourceMatchers, extraFileMatchers], it => copyFiles(it))

    if (this.info.cancellationToken.cancelled) {
      return
    }

    await this.info.afterPack(packContext)
    await this.sanityCheckPackage(appOutDir, asarOptions != null)
    await this.signApp(packContext)
    await this.info.afterSign(packContext)
  }

  protected async beforeCopyExtraFiles(appOutDir: string, asarIntegrity: AsarIntegrity | null) {
    // empty impl
  }

  private copyAppFiles(taskManager: AsyncTaskManager, asarOptions: AsarOptions | null, resourcePath: string, outDir: string, platformSpecificBuildOptions: DC, excludePatterns: Array<Minimatch>, macroExpander: ((it: string) => string)) {
    const appDir = this.info.appDir
    const config = this.config
    const isElectronCompile = asarOptions != null && isElectronCompileUsed(this.info)

    const defaultDestination = path.join(resourcePath, "app")

    const mainMatchers = getMainFileMatchers(appDir, defaultDestination, macroExpander, platformSpecificBuildOptions, this, outDir, isElectronCompile)
    if (excludePatterns.length > 0) {
      for (const matcher of mainMatchers) {
        matcher.excludePatterns = excludePatterns
      }
    }
    const transformer = createTransformer(appDir, config, isElectronCompile ? {
      originalMain: this.info.metadata.main,
      main: ELECTRON_COMPILE_SHIM_FILENAME, ...config.extraMetadata
    } : config.extraMetadata)
    const _computeFileSets = (matchers: Array<FileMatcher>) => {
      return computeFileSets(matchers, transformer, this.info, isElectronCompile)
        .then(it => it.filter(it => it.files.length > 0))
    }

    if (this.info.isPrepackedAppAsar) {
      taskManager.addTask(BluebirdPromise.each(_computeFileSets([new FileMatcher(appDir, resourcePath, macroExpander)]), it => copyAppFiles(it, this.info)))
    }
    else if (asarOptions == null) {
      taskManager.addTask(BluebirdPromise.each(_computeFileSets(mainMatchers), it => copyAppFiles(it, this.info)))
    }
    else {
      const unpackPattern = getFileMatchers(config, "asarUnpack", appDir, defaultDestination, macroExpander, platformSpecificBuildOptions)
      const fileMatcher = unpackPattern == null ? null : unpackPattern[0]
      taskManager.addTask(_computeFileSets(mainMatchers)
        .then(fileSets => new AsarPackager(appDir, resourcePath, asarOptions, fileMatcher == null ? null : fileMatcher.createFilter()).pack(fileSets, this)))
    }
  }

  // tslint:disable-next-line:no-empty
  protected async postInitApp(packContext: AfterPackContext): Promise<any> {
  }

  protected signApp(packContext: AfterPackContext): Promise<any> {
    return Promise.resolve()
  }

  async getIconPath(): Promise<string | null> {
    return null
  }

  private async computeAsarOptions(customBuildOptions: DC): Promise<AsarOptions | null> {
    function errorMessage(name: string) {
      return `${name} is deprecated is deprecated and not supported — please use asarUnpack`
    }

    const buildMetadata = this.config as any
    if (buildMetadata["asar-unpack"] != null) {
      throw new Error(errorMessage("asar-unpack"))
    }
    if (buildMetadata["asar-unpack-dir"] != null) {
      throw new Error(errorMessage("asar-unpack-dir"))
    }

    const platformSpecific = customBuildOptions.asar
    const result = platformSpecific == null ? this.config.asar : platformSpecific
    if (result === false) {
      const appAsarStat = await statOrNull(path.join(this.info.appDir, "app.asar"))
      //noinspection ES6MissingAwait
      if (appAsarStat == null || !appAsarStat.isFile()) {
        log.warn({
          solution: "enable asar and use asarUnpack to unpack files that must be externally available",
        }, "asar using is disabled — it is strongly not recommended")
      }
      return null
    }

    if (result == null || result === true) {
      return {}
    }

    for (const name of ["unpackDir", "unpack"]) {
      if ((result as any)[name] != null) {
        throw new Error(errorMessage(`asar.${name}`))
      }
    }
    return deepAssign({}, result)
  }

  public getElectronSrcDir(dist: string): string {
    return path.resolve(this.projectDir, dist)
  }

  public getElectronDestinationDir(appOutDir: string): string {
    return appOutDir
  }

  public getResourcesDir(appOutDir: string): string {
    return this.platform === Platform.MAC ? this.getMacOsResourcesDir(appOutDir) : path.join(appOutDir, "resources")
  }

  public getMacOsResourcesDir(appOutDir: string): string {
    return path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents", "Resources")
  }

  private async checkFileInPackage(resourcesDir: string, file: string, messagePrefix: string, isAsar: boolean) {
    const relativeFile = path.relative(this.info.appDir, path.resolve(this.info.appDir, file))
    if (isAsar) {
      await checkFileInArchive(path.join(resourcesDir, "app.asar"), relativeFile, messagePrefix)
      return
    }

    const pathParsed = path.parse(file)
    // Even when packaging to asar is disabled, it does not imply that the main file can not be inside an .asar archive.
    // This may occur when the packaging is done manually before processing with electron-builder.
    if (pathParsed.dir.includes(".asar")) {
      // The path needs to be split to the part with an asar archive which acts like a directory and the part with
      // the path to main file itself. (e.g. path/arch.asar/dir/index.js -> path/arch.asar, dir/index.js)
      const pathSplit: Array<string> = pathParsed.dir.split(path.sep)
      let partWithAsarIndex = 0
      pathSplit.some((pathPart: string, index: number) => {
        partWithAsarIndex = index
        return pathPart.endsWith(".asar")
      })
      const asarPath = path.join.apply(path, pathSplit.slice(0, partWithAsarIndex + 1))
      let mainPath = pathSplit.length > (partWithAsarIndex + 1) ? path.join.apply(pathSplit.slice(partWithAsarIndex + 1)) : ""
      mainPath += path.join(mainPath, pathParsed.base)
      await checkFileInArchive(path.join(resourcesDir, "app", asarPath), mainPath, messagePrefix)
    }
    else {
      const outStat = await statOrNull(path.join(resourcesDir, "app", relativeFile))
      if (outStat == null) {
        throw new Error(`${messagePrefix} "${relativeFile}" does not exist. Seems like a wrong configuration.`)
      }
      else {
        //noinspection ES6MissingAwait
        if (!outStat.isFile()) {
          throw new Error(`${messagePrefix} "${relativeFile}" is not a file. Seems like a wrong configuration.`)
        }
      }
    }
  }

  private async sanityCheckPackage(appOutDir: string, isAsar: boolean): Promise<any> {
    const outStat = await statOrNull(appOutDir)
    if (outStat == null) {
      throw new Error(`Output directory "${appOutDir}" does not exist. Seems like a wrong configuration.`)
    }
    else {
      //noinspection ES6MissingAwait
      if (!outStat.isDirectory()) {
        throw new Error(`Output directory "${appOutDir}" is not a directory. Seems like a wrong configuration.`)
      }
    }

    const resourcesDir = this.getResourcesDir(appOutDir)
    await this.checkFileInPackage(resourcesDir, this.info.metadata.main || "index.js", "Application entry file", isAsar)
    await this.checkFileInPackage(resourcesDir, "package.json", "Application", isAsar)
  }

  computeSafeArtifactName(suggestedName: string | null, ext: string, arch?: Arch | null, skipArchIfX64 = true): string | null {
    // GitHub only allows the listed characters in file names.
    if (suggestedName != null && isSafeGithubName(suggestedName)) {
      return null
    }

    // tslint:disable-next-line:no-invalid-template-strings
    return this.computeArtifactName("${name}-${version}-${arch}.${ext}", ext, skipArchIfX64 && arch === Arch.x64 ? null : arch)
  }

  expandArtifactNamePattern(targetSpecificOptions: TargetSpecificOptions | null | undefined, ext: string, arch?: Arch | null, defaultPattern?: string, skipArchIfX64 = true): string {
    let pattern = targetSpecificOptions == null ? null : targetSpecificOptions.artifactName
    if (pattern == null) {
      // tslint:disable-next-line:no-invalid-template-strings
      pattern = this.platformSpecificBuildOptions.artifactName || this.config.artifactName || defaultPattern || "${productName}-${version}-${arch}.${ext}"
    }
    return this.computeArtifactName(pattern, ext, skipArchIfX64 && arch === Arch.x64 ? null : arch)
  }

  private computeArtifactName(pattern: any, ext: string, arch: Arch | null | undefined) {
    let archName: string | null = arch == null ? null : Arch[arch]
    if (arch === Arch.x64) {
      if (ext === "AppImage" || ext === "rpm") {
        archName = "x86_64"
      }
      else if (ext === "deb") {
        archName = "amd64"
      }
    }
    else if (arch === Arch.ia32) {
      if (ext === "deb" || ext === "AppImage") {
        archName = "i386"
      }
      else if (ext === "pacman" || ext === "rpm") {
        archName = "i686"
      }
    }

    return this.expandMacro(pattern, this.platform === Platform.MAC ? null : archName, {
      ext
    })
  }

  expandMacro(pattern: string, arch?: string | null, extra: any = {}, isProductNameSanitized = true): string {
    if (arch == null) {
      pattern = pattern
      // tslint:disable-next-line:no-invalid-template-strings
        .replace("-${arch}", "")
        // tslint:disable-next-line:no-invalid-template-strings
        .replace(" ${arch}", "")
        // tslint:disable-next-line:no-invalid-template-strings
        .replace("_${arch}", "")
        // tslint:disable-next-line:no-invalid-template-strings
        .replace("/${arch}", "")
    }

    const appInfo = this.appInfo
    return pattern.replace(/\${([_a-zA-Z./*]+)}/g, (match, p1): string => {
      switch (p1) {
        case "productName":
          return isProductNameSanitized ? appInfo.productFilename : appInfo.productName

        case "arch":
          if (arch == null) {
            // see above, we remove macro if no arch
            return ""
          }
          return arch

        case "os":
          return this.platform.buildConfigurationKey

        case "channel":
          return appInfo.channel || "latest"

        default:
          if (p1 in appInfo) {
            return (appInfo as any)[p1]
          }

          if (p1.startsWith("env.")) {
            const envName = p1.substring("env.".length)
            const envValue = process.env[envName]
            if (envValue == null) {
              throw new InvalidConfigurationError(`cannot expand pattern "${pattern}": env ${envName} is not defined`, "ERR_ELECTRON_BUILDER_ENV_NOT_DEFINED")
            }
            return envValue
          }

          const value = extra[p1]
          if (value == null) {
            throw new InvalidConfigurationError(`cannot expand pattern "${pattern}": macro ${p1} is not defined`, "ERR_ELECTRON_BUILDER_MACRO_NOT_DEFINED")
          }
          else {
            return value
          }
      }
    })
  }

  generateName(ext: string | null, arch: Arch, deployment: boolean, classifier: string | null = null): string {
    let c: string | null = null
    let e: string | null = null
    if (arch === Arch.x64) {
      if (ext === "AppImage") {
        c = "x86_64"
      }
      else if (ext === "deb") {
        c = "amd64"
      }
    }
    else if (arch === Arch.ia32 && ext === "deb") {
      c = "i386"
    }
    else if (ext === "pacman") {
      if (arch === Arch.ia32) {
        c = "i686"
      }
      e = "pkg.tar.xz"
    }
    else {
      c = Arch[arch]
    }

    if (c == null) {
      c = classifier
    }
    else if (classifier != null) {
      c += `-${classifier}`
    }
    if (e == null) {
      e = ext
    }
    return this.generateName2(e, c, deployment)
  }

  generateName2(ext: string | null, classifier: string | null | undefined, deployment: boolean): string {
    const dotExt = ext == null ? "" : `.${ext}`
    const separator = ext === "deb" ? "_" : "-"
    return `${deployment ? this.appInfo.name : this.appInfo.productFilename}${separator}${this.appInfo.version}${classifier == null ? "" : `${separator}${classifier}`}${dotExt}`
  }

  getTempFile(suffix: string): Promise<string> {
    return this.info.tempDirManager.getTempFile({suffix})
  }

  get fileAssociations(): Array<FileAssociation> {
    return asArray(this.config.fileAssociations).concat(asArray(this.platformSpecificBuildOptions.fileAssociations))
  }

  async getResource(custom: string | null | undefined, ...names: Array<string>): Promise<string | null> {
    const resourcesDir = this.info.buildResourcesDir
    if (custom === undefined) {
      const resourceList = await this.resourceList
      for (const name of names) {
        if (resourceList.includes(name)) {
          return path.join(resourcesDir, name)
        }
      }
    }
    else if (custom != null && !isEmptyOrSpaces(custom)) {
      const resourceList = await this.resourceList
      if (resourceList.includes(custom)) {
        return path.join(resourcesDir, custom)
      }

      let p = path.resolve(resourcesDir, custom)
      if (await statOrNull(p) == null) {
        p = path.resolve(this.projectDir, custom)
        if (await statOrNull(p) == null) {
          throw new InvalidConfigurationError(`cannot find specified resource "${custom}", nor relative to "${resourcesDir}", neither relative to project dir ("${this.projectDir}")`)
        }
      }
      return p
    }
    return null
  }

  get forceCodeSigning(): boolean {
    const forceCodeSigningPlatform = this.platformSpecificBuildOptions.forceCodeSigning
    return (forceCodeSigningPlatform == null ? this.config.forceCodeSigning : forceCodeSigningPlatform) || false
  }

  protected async getOrConvertIcon(format: IconFormat): Promise<string | null> {
    const iconPath = this.platformSpecificBuildOptions.icon || this.config.icon
    if (iconPath != null) {
      const iconInfos = await this.resolveIcon([iconPath], format)
      return (iconInfos)[0].file
    }

    const resourceList = await this.resourceList
    const resourcesDir = this.info.buildResourcesDir
    const sourceNames = [`icon.${format === "set" ? "png" : format}`, "icon.png", "icons"]
    if (format === "ico") {
      sourceNames.push("icon.icns")
    }
    for (const fileName of sourceNames) {
      if (resourceList.includes(fileName)) {
        return (await this.resolveIcon([path.join(resourcesDir, fileName)], format))[0].file
      }
    }

    log.warn({reason: "application icon is not set"}, "default Electron icon is used")
    return null
  }

  // convert if need, validate size (it is a reason why tool is called even if file has target extension (already specified as foo.icns for example))
  async resolveIcon(sources: Array<string>, outputFormat: IconFormat): Promise<Array<IconInfo>> {
    const args = [
      "icon",
      "--format", outputFormat,
      "--root", this.buildResourcesDir,
      "--root", this.projectDir,
      "--out", path.resolve(this.projectDir, this.config.directories!!.output!!, `.icon-${outputFormat}`),
    ]
    for (const source of sources) {
      args.push("--input", source)
    }

    const rawResult = await executeAppBuilder(args)
    let result: IconConvertResult
    try {
      result = JSON.parse(rawResult)
    }
    catch (e) {
      throw new Error(`Cannot parse result: ${e.message}: ${rawResult}`)
    }

    const errorMessage = result.error
    if (errorMessage != null) {
      throw new InvalidConfigurationError(errorMessage, result.errorCode)
    }
    return result.icons!!
  }
}

export interface IconInfo {
  file: string
  size: number
}

interface IconConvertResult {
  icons?: Array<IconInfo>

  error?: string
  errorCode?: string
}

export type IconFormat = "icns" | "ico" | "set"

export function isSafeGithubName(name: string) {
  return /^[0-9A-Za-z._-]+$/.test(name)
}

// remove leading dot
export function normalizeExt(ext: string) {
  return ext.startsWith(".") ? ext.substring(1) : ext
}

export function resolveFunction<T>(executor: T | string): T {
  if (typeof executor !== "string") {
    return executor
  }

  let p = executor as string
  if (p.startsWith(".")) {
    p = path.resolve(p)
  }
  try {
    p = require.resolve(p)
  }
  catch (e) {
    debug(e)
    p = path.resolve(p)
  }

  const m = require(p)
  return m.default || m
}

export function chooseNotNull(v1: string | null | undefined, v2: string | null | undefined): string | null | undefined {
  return v1 == null ? v2 : v1
}