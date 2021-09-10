import {
  join,
} from 'path'
import {
  SecretValue,
  Construct,
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

export type SourceConfig = CodeCommitSourceConfig | GitHubSourceConfig | S3SourceConfig

/**/

export enum ComputeSize {
  Small = 'Small',
  Medium = 'Medium',
  Large = 'Large',
  X2Large = '2xLarge',
}

export interface KeyValue {
  [key: string]: string | number,
}

export interface StageConfig {
  compute?: ComputeSize,
  runtimes?: KeyValue,
  specFilename?: string,
}

export interface BuildConfig extends StageConfig {
  privileged?: boolean,
  prebuildScript?: string,
  postbuildScript?: string,
  envVars?: KeyValue,
  args?: string[],
  kvArgs?: KeyValue,
}

export interface StagingConfig extends StageConfig {}

export interface TestConfig extends StageConfig {}

export interface ValidateConfig extends StageConfig {
  emails?: string[],
}

export interface DeployConfig extends StageConfig {}

export interface PipelineConfig {
  source: SourceConfig,
  build?: BuildConfig,
  staging?: StagingConfig,
  test?: TestConfig,
  validate?: ValidateConfig,
  deploy?: DeployConfig,
}

export interface DeployableConfig {
  pipeline: PipelineConfig,
}

// Builder Functions

interface BasePipelineHelperProps {
  prefix?: string,
}

export interface CodeCommitSourceActionProps extends BasePipelineHelperProps, CodeCommitSourceConfig {}

export interface GitHubSourceActionProps extends BasePipelineHelperProps, GitHubSourceConfig {}

export interface S3SourceActionProps extends BasePipelineHelperProps, S3SourceConfig {
  key: string,
}

export type SourceActionProps = CodeCommitSourceActionProps | GitHubSourceActionProps | S3SourceActionProps

export function buildSourceAction (scope: Construct, sourceActionProps: SourceActionProps) {
  const prefix = sourceActionProps.prefix??''
  const sourceArtifactId = prefix + 'SourceArtifact'
  const sourceArtifact = new Artifact(sourceArtifactId)
  const sourceId = prefix + 'Source'
  const actionName = prefix + 'Source'
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

export interface YarnSynthActionProps extends BasePipelineHelperProps, BuildConfig {
  sourceCode: Artifact,
  cacheBucket: IBucket,
}

export function buildYarnSynthAction (scope: Construct, yarnSynthActionProps: YarnSynthActionProps) {
  const prefix = yarnSynthActionProps.prefix??''
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
  const projectId = prefix + 'SynthProject'
  const cache = Cache.bucket(yarnSynthActionProps.cacheBucket, {
    prefix: projectId,
  })
  const synthProject = new PipelineProject(scope, projectId, {
    buildSpec: synthSpec,
    environment,
    cache,
  })
  const actionName = prefix + 'Synth'
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

export interface ArchiValidateActionProps extends BasePipelineHelperProps, ValidateConfig {
  cloudAssembly: Artifact,
  runOrder?: number,
  cacheBucket: IBucket,
}

export function buildArchiValidateAction (scope: Construct, archiValidateActionProps: ArchiValidateActionProps) {
  const prefix = archiValidateActionProps.prefix??''
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
  const projectId = prefix + 'DiagramProject'
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
  const actionName = prefix + 'Diagram'
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

export interface ContBuildActionProps extends BasePipelineHelperProps, BuildConfig {
  sourceCode: Artifact,
  inEnvVars?: KeyValue,
  inKvArgs?: KeyValue,
  installCommands?: string[],
  prebuildCommands?: string[],
  postbuildCommands?: string[],
  repoName?: string,
}

export function buildContBuildAction (scope: Construct, contBuildActionProps: ContBuildActionProps) {
  const prefix = contBuildActionProps.prefix??''
  const contRepoId = prefix + 'ContRepo'
  const contRepo = contBuildActionProps.repoName ?
    EcrRepository.fromRepositoryName(scope, contRepoId, contBuildActionProps.repoName) :
    new EcrRepository(scope, contRepoId)
  const envVar = {
    ...contBuildActionProps.inKvArgs,
    ...contBuildActionProps.kvArgs,
    ...contBuildActionProps.inEnvVars,
    ...contBuildActionProps.envVars,
    PREBUILD_SCRIPT: contBuildActionProps.prebuildScript,
    POSTBUILD_SCRIPT: contBuildActionProps.postbuildScript,
  }
  const runtimes = {
    ...contBuildActionProps.runtimes,
    docker: 19,
  }
  const installCommands = []
  installCommands.push(...contBuildActionProps.installCommands??[])
  const prebuildCommands = []
  prebuildCommands.push(...contBuildActionProps.prebuildCommands??[])
  prebuildCommands.push(
    '[ -f "${PREBUILD_SCRIPT}" ] && . ./${PREBUILD_SCRIPT} || [ ! -f "${PREBUILD_SCRIPT}" ]',
    'aws ecr get-login-password | docker login --username AWS --password-stdin ' + contRepo.repositoryUri,
    'docker pull ' + contRepo.repositoryUri + ':latest || true',
  )
  const inKvArgKeys = Object.keys(contBuildActionProps.inKvArgs??{})
  const kvArgKeys = Object.keys(
    contBuildActionProps.kvArgs??{}
  ).concat(inKvArgKeys)
  const buildArgsParts = kvArgKeys.map(kvArgKey => '--build-arg ' + kvArgKey + '=${' + kvArgKey + '}')
  const buildCommandParts = [
    'DOCKER_BUILDKIT=1 docker build --build-arg BUILDKIT_INLINE_CACHE=1',
  ].concat(buildArgsParts)
  buildCommandParts.push(
    '--cache-from ' + contRepo.repositoryUri + ':latest -t ' + contRepo.repositoryUri + ':latest .',
  )
  const buildCommand = buildCommandParts.join(' ')
  const postbuildCommands = []
  postbuildCommands.push(
    'docker push ' + contRepo.repositoryUri,
    '[ -f "${POSTBUILD_SCRIPT}" ] && . ./${POSTBUILD_SCRIPT} || [ ! -f "${POSTBUILD_SCRIPT}" ]',
  )
  postbuildCommands.push(...contBuildActionProps.postbuildCommands??[])
  const contSpec = BuildSpec.fromObjectToYaml({
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
        commands: buildCommand,
      },
      post_build: {
        commands: postbuildCommands,
      },
    },
  })
  const computeType = mapCompute(contBuildActionProps.compute)
  const linuxPrivilegedEnv = {
    computeType,
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
    privileged: true,
  }
  const projectName = prefix + 'ContProject'
  const contProject = new PipelineProject(scope, projectName, {
    environment: linuxPrivilegedEnv,
    buildSpec: contSpec,
  })
  contRepo.grantPullPush(contProject)
  const actionName = prefix + 'ContBuild'
  const action = new CodeBuildAction({
    actionName,
    project: contProject,
    input: contBuildActionProps.sourceCode,
  })
  return {
    action,
    grantee: contProject,
    contRepo,
  }
}

export interface DroidBuildActionProps extends BasePipelineHelperProps, BuildConfig {
  sourceCode: Artifact,
  envVar?: KeyValue,
  prebuildCommands?: string[]
  postbuildCommands?: string[]
  cacheBucket: IBucket,
}

export function buildDroidBuildAction (scope: Construct, droidBuildActionProps: DroidBuildActionProps) {
  const prefix = droidBuildActionProps.prefix??''
  const apkFilesId = prefix + 'ApkFiles'
  const apkFiles = new Artifact(apkFilesId)
  const envVar = {
    ...droidBuildActionProps.envVar,
    PREBUILD_SCRIPT: droidBuildActionProps.prebuildScript,
    POSTBUILD_SCRIPT: droidBuildActionProps.postbuildScript,
  }
  const runtimes = {
    ...droidBuildActionProps.runtimes,
    android: 29,
    java: 'corretto8',
  }
  const prebuildCommands = []
  prebuildCommands.push(...droidBuildActionProps.prebuildCommands??[])
  prebuildCommands.push(
    '[ -f "${PREBUILD_SCRIPT}" ] && . ./${PREBUILD_SCRIPT} || [ ! -f "${PREBUILD_SCRIPT}" ]',
  )
  const postbuildCommands = []
  postbuildCommands.push(
    '[ -f "${POSTBUILD_SCRIPT}" ] && . ./${POSTBUILD_SCRIPT} || [ ! -f "${POSTBUILD_SCRIPT}" ]',
  )
  postbuildCommands.push(...droidBuildActionProps.postbuildCommands??[])
  const droidSpec = BuildSpec.fromObjectToYaml({
    version: '0.2',
    env: {
      variables: envVar,
    },
    phases: {
      install: {
        'runtime-versions': runtimes,        
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
  const projectId = prefix + 'DroidProject'
  const cache = Cache.bucket(droidBuildActionProps.cacheBucket, {
    prefix: projectId,
  })
  const droidProject = new PipelineProject(scope, projectId, {
    buildSpec: droidSpec,
    environment,
    cache,
  })
  const actionName = prefix + 'DroidBuild'
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

export interface CustomActionProps extends BasePipelineHelperProps, StageConfig {
  type?: CodeBuildActionType,
  input: Artifact,
  cacheBucket: IBucket,
}

export function buildCustomAction (scope: Construct, customActionProps: CustomActionProps) {
  const prefix = customActionProps.prefix??''
  const artifactId = prefix + 'Artifact'
  const artifact = new Artifact(artifactId)
  const buildSpec = customActionProps.specFilename ?
    BuildSpec.fromSourceFilename(customActionProps.specFilename) :
    undefined
  const computeType = mapCompute(customActionProps.compute)
  const environment = {
    computeType,
    buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
  }
  const projectId = prefix + 'Project'
  const cache = Cache.bucket(customActionProps.cacheBucket, {
    prefix: projectId,
  })
  const customProject = new PipelineProject(scope, projectId, {
    buildSpec,
    environment,
    cache,
  })
  const actionName = prefix + 'Action'
  const action = new CodeBuildAction({
    actionName,
    project: customProject,
    type: customActionProps.type,
    input: customActionProps.input,
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

export interface PyInvokeActionProps extends BasePipelineHelperProps {
  policies?: Policy[],
  path: string,
  index?: string,
  handler?: string,
  params?: KeyValue,
  runOrder?: number,
}

export function buildPyInvokeAction (scope: Construct, pyInvokeActionProps: PyInvokeActionProps) {
  const prefix = pyInvokeActionProps.prefix??''
  const initialPolicy = pyInvokeActionProps.policies?.map(policy => new PolicyStatement(policy))
  const entry = join(__dirname, pyInvokeActionProps.path)
  const handlerName = prefix + 'Handler'
  const lambda = new PythonFunction(scope, handlerName, {
    entry,
    index: pyInvokeActionProps.index,
    handler: pyInvokeActionProps.handler,
    initialPolicy,
  })
  const actionName = prefix + 'Action'
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
