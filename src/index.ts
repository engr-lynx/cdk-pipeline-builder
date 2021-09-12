import {
  join,
} from 'path'
import {
  SecretValue,
  Construct,
  RemovalPolicy,
} from '@aws-cdk/core'
import {
  Artifact,
} from '@aws-cdk/aws-codepipeline'
import {
  GitHubSourceAction,
  CodeCommitSourceAction,
  S3SourceAction,
  CodeBuildAction,
  CodeBuildActionType,
  LambdaInvokeAction,
} from '@aws-cdk/aws-codepipeline-actions'
import {
  Repository,
} from '@aws-cdk/aws-codecommit'
import {
  PipelineProject,
  ComputeType,
  LinuxBuildImage,
  BuildSpec,
  Cache,
} from '@aws-cdk/aws-codebuild'
import {
  Repository as EcrRepository,
} from '@aws-cdk/aws-ecr'
import {
  Bucket,
  IBucket,
} from '@aws-cdk/aws-s3'
import {
  Asset,
} from '@aws-cdk/aws-s3-assets'
import {
  PythonFunction,
} from '@aws-cdk/aws-lambda-python'
import {
  PolicyStatement,
} from '@aws-cdk/aws-iam'
import {
  Cdn,
} from '@engr-lynx/cdk-service-patterns'

// ToDo: Unify naming (including prefix usage)
// ToDo: Coding standards: flatten nested tabs; operator spacing

// Config Definitions

export class PipelineConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PipelineConfigError'
  }
}

/**/

export enum SourceType {
  CodeCommit = 'CodeCommit',
  GitHub = 'GitHub',
  S3 = 'S3',
}

interface BaseSourceConfig {
  type: SourceType,
}

export interface CodeCommitSourceConfig extends BaseSourceConfig {
  type: SourceType.CodeCommit,
  name: string,
  create?: boolean,
}

export interface GitHubSourceConfig extends BaseSourceConfig {
  type: SourceType.GitHub,
  name: string,
  tokenName: string,
  owner: string,
}

export interface S3SourceConfig extends BaseSourceConfig {
  type: SourceType.S3,
}

export enum ComputeSize {
  Small = 'Small',
  Medium = 'Medium',
  Large = 'Large',
  X2Large = '2xLarge',
}

interface BaseComputeStageConfig {
  compute?: ComputeSize,
}

export interface KeyValue {
  [key: string]: string | number,
}

interface BaseCustomBuildConfig extends BaseComputeStageConfig {
  runtimes?: KeyValue,
  installScript?: string,
  prebuildScript?: string,
  postbuildScript?: string,
  envVars?: KeyValue,
  envSecrets?: KeyValue,
}

export interface ImageBuildConfig extends BaseCustomBuildConfig {
  envVarArgs?: KeyValue,
  envSecretArgs?: KeyValue,
  deleteRepoWithApp?: boolean,
}

export interface DroidBuildConfig extends BaseCustomBuildConfig {}

interface BaseSpecDefinedStageConfig extends BaseComputeStageConfig {
  specFilename?: string,
}

export interface SpecDefinedBuildConfig extends BaseSpecDefinedStageConfig {
  privileged?: boolean,
}

export interface SpecDefinedStagingConfig extends BaseSpecDefinedStageConfig {}

export interface SpecDefinedTestConfig extends BaseSpecDefinedStageConfig {}

interface BaseValidateConfig {
  emails?: string[],
}

export interface SpecDefinedValidateConfig extends BaseSpecDefinedStageConfig, BaseValidateConfig {}

export interface SpecDefinedDeployConfig extends BaseSpecDefinedStageConfig {}

export type SourceConfig = CodeCommitSourceConfig | GitHubSourceConfig | S3SourceConfig

export type BuildConfig = ImageBuildConfig | DroidBuildConfig | SpecDefinedBuildConfig

export type StagingConfig = SpecDefinedStagingConfig

export type TestConfig = SpecDefinedTestConfig

export type ValidateConfig = SpecDefinedValidateConfig

export type DeployConfig = SpecDefinedDeployConfig

export interface AppPipelineConfig {
  source: SourceConfig,
  build?: BuildConfig,
  staging?: StagingConfig,
  test?: TestConfig,
  validate?: ValidateConfig,
  deploy?: DeployConfig,
}

export interface DeployableAppConfig {
  pipeline: AppPipelineConfig,
}

export interface YarnSynthConfig extends BaseComputeStageConfig {}

export type SynthConfig = YarnSynthConfig

export interface ArchiPipelineConfig {
  source: SourceConfig,
  synth?: SynthConfig,
  validate?: ValidateConfig,
}

export interface DeployableArchiConfig {
  pipeline: ArchiPipelineConfig,
}

// Builder Functions

// ToDo: Reorganize Props interfaces similar to Config interfaces
interface BasePipelineBuilderProps {
  prefix?: string,
}

export interface CodeCommitSourceActionProps extends BasePipelineBuilderProps, CodeCommitSourceConfig {}

export interface GitHubSourceActionProps extends BasePipelineBuilderProps, GitHubSourceConfig {}

export interface S3SourceActionProps extends BasePipelineBuilderProps, S3SourceConfig {
  key: string,
}

export type SourceActionProps = CodeCommitSourceActionProps | GitHubSourceActionProps | S3SourceActionProps

export function createSourceAction (scope: Construct, sourceActionProps: SourceActionProps) {
  const prefix = sourceActionProps.prefix ?? 'Source'
  const sourceArtifactId = prefix + 'Artifact'
  const sourceArtifact = new Artifact(sourceArtifactId)
  const sourceId = prefix
  const actionName = prefix
  let source
  let action
  switch(sourceActionProps.type) {
    case SourceType.CodeCommit:
      const codeCommitSourceActionProps = sourceActionProps as CodeCommitSourceActionProps
      source = codeCommitSourceActionProps.create ?
        new Repository(scope, sourceId, {
          repositoryName: codeCommitSourceActionProps.name,
        }) :
        Repository.fromRepositoryName(scope, sourceId, codeCommitSourceActionProps.name)
      action = new CodeCommitSourceAction({
        actionName,
        output: sourceArtifact,
        repository: source,
      })
      break
    case SourceType.GitHub:
      const gitHubSourceActionProps = sourceActionProps as GitHubSourceActionProps
      const gitHubToken = SecretValue.secretsManager(gitHubSourceActionProps.tokenName)
      action = new GitHubSourceAction({
        actionName,
        output: sourceArtifact,
        oauthToken: gitHubToken,
        owner: gitHubSourceActionProps.owner,
        repo: gitHubSourceActionProps.name,
      })
      break
    case SourceType.S3:
      const s3SourceActionProps = sourceActionProps as S3SourceActionProps
      source = new Bucket(scope, sourceId, {
        versioned: true,
      })
      action = new S3SourceAction({
        actionName,
        output: sourceArtifact,
        bucket: source,
        bucketKey: s3SourceActionProps.key,
      })
      break
    default:
      throw new Error('Unsupported Type')
  }
  return {
    action,
    sourceArtifact,
    source,
  }
}

export interface BaseBuildProps extends BasePipelineBuilderProps {
  sourceCode: Artifact,
}

export interface YarnSynthActionProps extends BaseBuildProps, YarnSynthConfig {
  cacheBucket: IBucket,
}

export function createYarnSynthAction (scope: Construct, yarnSynthActionProps: YarnSynthActionProps) {
  const prefix = yarnSynthActionProps.prefix ?? 'Synth'
  const cloudAssemblyId = prefix + 'CloudAssembly'
  const cloudAssembly = new Artifact(cloudAssemblyId)
  const runtimes = {
    nodejs: 12,
    docker: 19,
  }
  const installCommands = [
    'yarn install',
  ]
  const prebuildCommands = [
    'npx yaml2json cdk.context.yaml > cdk.context.json',
  ]
  const buildCommands = [
    'npx cdk synth',
  ]
  const synthSpec = BuildSpec.fromObjectToYaml({
    version: '0.2',
    phases: {
      install: {
        'runtime-versions': runtimes,
        commands: installCommands,
      },
      pre_build: {
        commands: prebuildCommands,
      },
      build: {
        commands: buildCommands,
      },
    },
    artifacts: {
      'base-directory': './cdk.out',
      files: [
        '**/*',
      ],
    },
    cache: {
      paths: [
        './node_modules/**/*',
      ],
    },
  })
  const computeType = mapCompute(yarnSynthActionProps.compute)
  const environment = {
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
    computeType,
    privileged: true,
  }
  const projectId = prefix + 'Project'
  const cache = Cache.bucket(yarnSynthActionProps.cacheBucket, {
    prefix: projectId,
  })
  const synthProject = new PipelineProject(scope, projectId, {
    buildSpec: synthSpec,
    environment,
    cache,
  })
  const actionName = prefix
  const action = new CodeBuildAction({
    actionName,
    project: synthProject,
    input: yarnSynthActionProps.sourceCode,
    outputs: [
      cloudAssembly,
    ],
  })
  return {
    action,
    cloudAssembly,
  }
}

export interface ArchiValidateActionProps extends BasePipelineBuilderProps, ValidateConfig {
  cloudAssembly: Artifact,
  runOrder?: number,
  cacheBucket: IBucket,
}

export function createArchiValidateAction (scope: Construct, archiValidateActionProps: ArchiValidateActionProps) {
  const prefix = archiValidateActionProps.prefix ?? 'Validate'
  const diagramsSite = new Cdn(scope, 'DiagramsSite')
  const path = join(__dirname, 'cloud-diagrams/index.html')
  const diagramsIndex = new Asset(scope, 'DiagramsIndex', {
    path,
  })
  const envVar = {
    SITE_SOURCE: diagramsSite.source.s3UrlForObject(),
    SITE_DISTRIBUTION: diagramsSite.distribution.distributionId,
    INDEX_ASSET: diagramsIndex.s3ObjectUrl,
  }
  const runtimes = {
    nodejs: 12,
  }
  const installCommands = [
    'yarn global add @mhlabs/cfn-diagram',
  ]
  const prebuildCommands = [
    'mkdir out',
    'jq -n "[]" > ./out/templates.json',
    'cd assembly-*',
  ]
  const buildCommands = [
    `for f in *.template.json do 
      cfn-dia h -c -t "\${f}" -o "../out/\${f%.template.json}"  
      echo $( jq ". + [\\"\${f%.template.json}\\"]" ../out/templates.json ) > ../out/templates.json  
    done`,
  ]
  const postbuildCommands = [
    'aws s3 sync ../out/ ${SITE_SOURCE}',
    'aws s3 cp ${INDEX_ASSET} ${SITE_SOURCE}/index.html --content-type text/html --metadata-directive REPLACE',
    'aws cloudfront create-invalidation --distribution-id ${SITE_DISTRIBUTION} --paths "/*"',
  ]
  const diagramsSpec = BuildSpec.fromObjectToYaml({
    version: '0.2',
    env: {
      variables: envVar,
    },
    phases: {
      install: {
        'runtime-versions': runtimes,
        commands: installCommands,
      },
      pre_build: {
        commands: prebuildCommands,
      },
      build: {
        commands: buildCommands,
      },
      post_build: {
        commands: postbuildCommands,
      },
    },
    cache: {
      paths: [
        '/usr/local/share/.config/yarn/global/**/*',
        '${HOME}/.config/yarn/global/**/*',
      ],
    },
  })
  const computeType = mapCompute(archiValidateActionProps.compute)
  const environment = {
    computeType,
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
  }
  const projectId = prefix + 'Project'
  const cache = Cache.bucket(archiValidateActionProps.cacheBucket, {
    prefix: projectId,
  })
  const diagramsProject = new PipelineProject(scope, projectId, {
    buildSpec: diagramsSpec,
    environment,
    cache,
  })
  diagramsSite.source.grantReadWrite(diagramsProject)
  diagramsIndex.grantRead(diagramsProject)
  diagramsSite.distribution.grantInvalidate(diagramsProject)
  const actionName = prefix
  const action = new CodeBuildAction({
    actionName,
    project: diagramsProject,
    input: archiValidateActionProps.cloudAssembly,
    runOrder: archiValidateActionProps.runOrder,
  })
  return {
    action,
    source: diagramsSite.source,
    distribution: diagramsSite.distribution,
  }
}

export interface ImageBuildActionProps extends BaseBuildProps, ImageBuildConfig {
  inRuntimes?: KeyValue,
  inEnvVars?: KeyValue,
  inEnvSecrets?: KeyValue,
  inEnvVarArgs?: KeyValue,
  inEnvSecretArgs?: KeyValue,
  installCommands?: string[],
  prebuildCommands?: string[],
  postbuildCommands?: string[],
}

// ToDo: Add INSTALL_SCRIPT
export function createImageBuildAction (scope: Construct, imageBuildActionProps: ImageBuildActionProps) {
  const prefix = imageBuildActionProps.prefix ?? 'Build'
  const imageRepoId = prefix + 'Repo'
  const removalPolicy = imageBuildActionProps.deleteRepoWithApp ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN
  const imageRepo = new EcrRepository(scope, imageRepoId, {
    removalPolicy,
  })
  const runtimes ={
    ...imageBuildActionProps.inRuntimes,
    ...imageBuildActionProps.runtimes,
  }
  const allRuntimes = {
    ...runtimes,
    docker: 19,
  }
  const envVarArgs ={
    ...imageBuildActionProps.inEnvVarArgs,
    ...imageBuildActionProps.envVarArgs,
  }
  const envVars = {
    ...imageBuildActionProps.inEnvVars,
    ...imageBuildActionProps.envVars,
  }
  const envSecretArgs ={
    ...imageBuildActionProps.inEnvSecretArgs,
    ...imageBuildActionProps.envSecretArgs,
  }
  const envSecrets = {
    ...imageBuildActionProps.inEnvSecrets,
    ...imageBuildActionProps.envSecrets,
  }
  const allEnvVars = {
    ...envVarArgs,
    ...envVars,
  }
  const allEnvSecrets = {
    ...envSecretArgs,
    ...envSecrets,
  }
  const installCommands = []
  installCommands.push(...imageBuildActionProps.installCommands ?? [])
  const installScript = imageBuildActionProps.installScript
  installCommands.push(
    '[ -f "' + installScript + '" ] && . ./' + installScript + ' || [ ! -f "' + installScript + '" ]',
  )
  const prebuildCommands = []
  prebuildCommands.push(...imageBuildActionProps.prebuildCommands ?? [])
  const prebuildScript = imageBuildActionProps.prebuildScript
  prebuildCommands.push(
    '[ -f "' + prebuildScript + '" ] && . ./' + prebuildScript + ' || [ ! -f "' + prebuildScript + '" ]',
    'aws ecr get-login-password | docker login --username AWS --password-stdin ' + imageRepo.repositoryUri,
    'docker pull ' + imageRepo.repositoryUri + ':latest || true',
  )
  const envVarArgKeys = Object.keys(envVarArgs ?? {})
  const envSecretArgKeys = Object.keys(envSecretArgs ?? {})
  let argKeys: string[] = []
  argKeys = argKeys.concat(envVarArgKeys).concat(envSecretArgKeys)
  const buildArgs = argKeys.map(argKey => '--build-arg ' + argKey + '=${' + argKey + '}')
  const buildCommandParts = [
    'DOCKER_BUILDKIT=1 docker build --build-arg BUILDKIT_INLINE_CACHE=1',
  ].concat(buildArgs)
  buildCommandParts.push(
    '--cache-from ' + imageRepo.repositoryUri + ':latest -t ' + imageRepo.repositoryUri + ':latest .',
  )
  const buildCommand = buildCommandParts.join(' ')
  const postbuildCommands = []
  const postbuildScript = imageBuildActionProps.postbuildScript
  postbuildCommands.push(
    'docker push ' + imageRepo.repositoryUri,
    '[ -f "' + postbuildScript + '" ] && . ./' + postbuildScript + ' || [ ! -f "' + postbuildScript + '" ]',
  )
  postbuildCommands.push(...imageBuildActionProps.postbuildCommands ?? [])
  const imageSpec = BuildSpec.fromObjectToYaml({
    version: '0.2',
    env: {
      variables: allEnvVars,
      'secrets-manager': allEnvSecrets,
    },
    phases: {
      install: {
        'runtime-versions': allRuntimes,
        commands: installCommands,
      },
      pre_build: {
        commands: prebuildCommands,
      },
      build: {
        commands: buildCommand,
      },
      post_build: {
        commands: postbuildCommands,
      },
    },
  })
  const computeType = mapCompute(imageBuildActionProps.compute)
  const linuxPrivilegedEnv = {
    computeType,
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
    privileged: true,
  }
  const projectName = prefix + 'Project'
  const imageProject = new PipelineProject(scope, projectName, {
    environment: linuxPrivilegedEnv,
    buildSpec: imageSpec,
  })
  imageRepo.grantPullPush(imageProject)
  const actionName = prefix
  const action = new CodeBuildAction({
    actionName,
    project: imageProject,
    input: imageBuildActionProps.sourceCode,
  })
  return {
    action,
    grantee: imageProject,
    imageRepo,
  }
}

export interface DroidBuildActionProps extends BaseBuildProps, DroidBuildConfig {
  inRuntimes?: KeyValue,
  inEnvVars?: KeyValue,
  inEnvSecrets?: KeyValue,
  installCommands?: string[],
  prebuildCommands?: string[]
  postbuildCommands?: string[]
  cacheBucket: IBucket,
}

export function createDroidBuildAction (scope: Construct, droidBuildActionProps: DroidBuildActionProps) {
  const prefix = droidBuildActionProps.prefix ?? 'Build'
  const apkFilesId = prefix + 'ApkFiles'
  const apkFiles = new Artifact(apkFilesId)
  const runtimes ={
    ...droidBuildActionProps.inRuntimes,
    ...droidBuildActionProps.runtimes,
  }
  const allRuntimes = {
    ...runtimes,
    android: 29,
    java: 'corretto8',
  }
  const envVars = {
    ...droidBuildActionProps.inEnvVars,
    ...droidBuildActionProps.envVars,
  }
  const envSecrets = {
    ...droidBuildActionProps.inEnvSecrets,
    ...droidBuildActionProps.envSecrets,
  }
  const installCommands = []
  installCommands.push(...droidBuildActionProps.installCommands ?? [])
  const installScript = droidBuildActionProps.installScript
  installCommands.push(
    '[ -f "' + installScript + '" ] && . ./' + installScript + ' || [ ! -f "' + installScript + '" ]',
  )
  const prebuildCommands = []
  prebuildCommands.push(...droidBuildActionProps.prebuildCommands ?? [])
  const prebuildScript = droidBuildActionProps.prebuildScript
  prebuildCommands.push(
    '[ -f "' + prebuildScript + '" ] && . ./' + prebuildScript + ' || [ ! -f "' + prebuildScript + '" ]',
  )
  const postbuildCommands = []
  const postbuildScript = droidBuildActionProps.postbuildScript
  postbuildCommands.push(
    '[ -f "' + postbuildScript + '" ] && . ./' + postbuildScript + ' || [ ! -f "' + postbuildScript + '" ]',
  )
  postbuildCommands.push(...droidBuildActionProps.postbuildCommands ?? [])
  const droidSpec = BuildSpec.fromObjectToYaml({
    version: '0.2',
    env: {
      variables: envVars,
      'secrets-manager': envSecrets,
    },
    phases: {
      install: {
        'runtime-versions': allRuntimes,        
        commands: installCommands,
      },
      pre_build: {
        commands: prebuildCommands,
      },
      build: {
        commands: './gradlew assembleDebug',
      },
      post_build: {
        commands: postbuildCommands,
      },
    },
    artifacts: {
      files: [
        './app/build/outputs/**/*.apk',
      ],
      'discard-paths': 'yes',
    },
    cache: {
      paths: [
        '${HOME}/.gradle/caches/**/*',
        '${HOME}/.gradle/jdks/**/*',
        '${HOME}/.gradle/wrapper/dists/**/*',
        './build-cache/**/*',
      ],
    },
  })
  const computeType = mapCompute(droidBuildActionProps.compute)
  const environment = {
    computeType,
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
  }
  const projectId = prefix + 'Project'
  const cache = Cache.bucket(droidBuildActionProps.cacheBucket, {
    prefix: projectId,
  })
  const droidProject = new PipelineProject(scope, projectId, {
    buildSpec: droidSpec,
    environment,
    cache,
  })
  const actionName = prefix
  const action = new CodeBuildAction({
    actionName,
    project: droidProject,
    input: droidBuildActionProps.sourceCode,
    outputs: [
      apkFiles,
    ],
  })
  return {
    action,
    grantee: droidProject,
    apkFiles,
  }
}

export interface SpecDefinedActionProps {
  cacheBucket: IBucket,
}

export interface SpecDefinedBuildActionProps extends BaseBuildProps, SpecDefinedActionProps, SpecDefinedBuildConfig {}

export function createSpecDefinedBuildAction (scope: Construct, specDefinedBuildActionProps: SpecDefinedBuildActionProps) {
  const prefix = specDefinedBuildActionProps.prefix ?? 'Build'
  const artifactId = prefix + 'Artifact'
  const artifact = new Artifact(artifactId)
  const specFilename = specDefinedBuildActionProps.specFilename ?? 'buildspec.yaml'
  const buildSpec = BuildSpec.fromSourceFilename(specFilename)
  const computeType = mapCompute(specDefinedBuildActionProps.compute)
  const environment = {
    computeType,
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
  }
  const projectId = prefix + 'Project'
  const cache = Cache.bucket(specDefinedBuildActionProps.cacheBucket, {
    prefix: projectId,
  })
  const customProject = new PipelineProject(scope, projectId, {
    buildSpec,
    environment,
    cache,
  })
  const actionName = prefix
  const action = new CodeBuildAction({
    actionName,
    project: customProject,
    input: specDefinedBuildActionProps.sourceCode,
    outputs: [
      artifact,
    ],
  })
  return {
    action,
    artifact,
  }
}

export interface SpecDefinedTestActionProps extends BasePipelineBuilderProps, SpecDefinedActionProps, TestConfig {
  input: Artifact,
}

// ToDo: Rename from custom to user-defined.
export function createSpecDefinedTestAction (scope: Construct, specDefinedTestActionProps: SpecDefinedTestActionProps) {
  const prefix = specDefinedTestActionProps.prefix ?? 'Test'
  const artifactId = prefix + 'Artifact'
  const artifact = new Artifact(artifactId)
  const specFilename = specDefinedTestActionProps.specFilename ?? 'testspec.yaml'
  const buildSpec = BuildSpec.fromSourceFilename(specFilename)
  const computeType = mapCompute(specDefinedTestActionProps.compute)
  const environment = {
    computeType,
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
  }
  const projectId = prefix + 'Project'
  const cache = Cache.bucket(specDefinedTestActionProps.cacheBucket, {
    prefix: projectId,
  })
  const customProject = new PipelineProject(scope, projectId, {
    buildSpec,
    environment,
    cache,
  })
  const actionName = prefix
  const action = new CodeBuildAction({
    actionName,
    project: customProject,
    type: CodeBuildActionType.TEST,
    input: specDefinedTestActionProps.input,
    outputs: [
      artifact,
    ],
  })
  return {
    action,
    artifact,
  }
}

interface Policy {
  actions: string[],
  resources: string [],
}

export interface PyInvokeActionProps extends BasePipelineBuilderProps {
  policies?: Policy[],
  path: string,
  index?: string,
  handler?: string,
  params?: KeyValue,
  runOrder?: number,
}

export function createPyInvokeAction (scope: Construct, pyInvokeActionProps: PyInvokeActionProps) {
  const prefix = pyInvokeActionProps.prefix ?? 'Invoke'
  const initialPolicy = pyInvokeActionProps.policies?.map(policy => new PolicyStatement(policy))
  const entry = join(__dirname, pyInvokeActionProps.path)
  const handlerName = prefix + 'Handler'
  const lambda = new PythonFunction(scope, handlerName, {
    entry,
    index: pyInvokeActionProps.index,
    handler: pyInvokeActionProps.handler,
    initialPolicy,
  })
  const actionName = prefix
  const action = new LambdaInvokeAction({
    actionName,
    lambda,
    userParameters: pyInvokeActionProps.params,
    runOrder: pyInvokeActionProps.runOrder,
  })
  return {
    action,
    grantee: lambda,
  }
}

export function mapCompute (compute?: ComputeSize) {
  switch (compute) {
    case ComputeSize.Small:
      return ComputeType.SMALL
    case ComputeSize.Medium:
      return ComputeType.MEDIUM
    case ComputeSize.Large:
      return ComputeType.LARGE
    case ComputeSize.X2Large:
      return ComputeType.X2_LARGE
    default:
      return
  }
}
