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
  Pipeline,
  Action,
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
  IRepository,
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
  Cdn,
  PythonResource,
} from '@engr-lynx/cdk-service-patterns'

// ToDo: These functions should be made into Resources or Constructs implementing IGrantable.
// ToDo: Unify naming (including prefix usage).
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
  readonly type: SourceType,
}

export interface CodeCommitSourceConfig extends BaseSourceConfig {
  readonly type: SourceType.CodeCommit,
  readonly name: string,
  readonly create?: boolean,
}

export interface GitHubSourceConfig extends BaseSourceConfig {
  readonly type: SourceType.GitHub,
  readonly name: string,
  readonly tokenName: string,
  readonly owner: string,
}

export interface S3SourceConfig extends BaseSourceConfig {
  readonly type: SourceType.S3,
  readonly key: string,
  readonly deleteSourceWithApp?: boolean,
}

export enum ComputeSize {
  Small = 'Small',
  Medium = 'Medium',
  Large = 'Large',
  X2Large = '2xLarge',
}

interface BaseComputeStageConfig {
  readonly compute?: ComputeSize,
}

export interface KeyValue {
  readonly [key: string]: string | number,
}

interface BaseCustomBuildConfig extends BaseComputeStageConfig {
  readonly runtimes?: KeyValue,
  readonly installScript?: string,
  readonly prebuildScript?: string,
  readonly postbuildScript?: string,
  readonly envVars?: KeyValue,
  readonly envSecrets?: KeyValue,
}

export interface ImageBuildConfig extends BaseCustomBuildConfig {
  readonly envVarArgs?: KeyValue,
  readonly envSecretArgs?: KeyValue,
  readonly deleteRepoWithApp?: boolean,
}

export interface DroidBuildConfig extends BaseCustomBuildConfig {}

interface BaseSpecDefinedStageConfig extends BaseComputeStageConfig {
  readonly specFilename?: string,
}

export interface SpecDefinedBuildConfig extends BaseSpecDefinedStageConfig {
  readonly privileged?: boolean,
}

export interface SpecDefinedStagingConfig extends BaseSpecDefinedStageConfig {}

export interface SpecDefinedTestConfig extends BaseSpecDefinedStageConfig {}

interface BaseValidateConfig {
  readonly emails?: string[],
}

export interface SpecDefinedValidateConfig extends BaseSpecDefinedStageConfig, BaseValidateConfig {}

export interface SpecDefinedDeployConfig extends BaseSpecDefinedStageConfig {}

export type SourceConfig = CodeCommitSourceConfig | GitHubSourceConfig | S3SourceConfig

export type BuildConfig = ImageBuildConfig | DroidBuildConfig | SpecDefinedBuildConfig

export type StagingConfig = SpecDefinedStagingConfig

export type TestConfig = SpecDefinedTestConfig

export type ValidateConfig = SpecDefinedValidateConfig

export type DeployConfig = SpecDefinedDeployConfig

interface BasePipelineConfig {
  readonly deleteArtifactsWithApp?: boolean,
  readonly restartExecutionOnUpdate?: boolean,
  readonly source?: SourceConfig,
}

export interface AppPipelineConfig extends BasePipelineConfig {
  readonly build?: BuildConfig,
  readonly staging?: StagingConfig,
  readonly test?: TestConfig,
  readonly validate?: ValidateConfig,
  readonly deploy?: DeployConfig,
}

export interface DeployableAppConfig {
  readonly pipeline: AppPipelineConfig,
}

export interface YarnSynthConfig extends BaseComputeStageConfig {}

export type SynthConfig = YarnSynthConfig

export interface ArchiPipelineConfig extends BasePipelineConfig {
  readonly synth?: SynthConfig,
  readonly validate?: ValidateConfig,
}

export interface DeployableArchiConfig {
  readonly pipeline: ArchiPipelineConfig,
}

// Builder Functions

// ToDo: Reorganize Props interfaces similar to Config interfaces
interface BasePipelineBuilderProps {
  readonly prefix?: string,
}

export interface CodeCommitSourceActionProps extends BasePipelineBuilderProps, CodeCommitSourceConfig {}

export interface GitHubSourceActionProps extends BasePipelineBuilderProps, GitHubSourceConfig {}

export interface S3SourceActionProps extends BasePipelineBuilderProps, S3SourceConfig {}

export type SourceActionProps = CodeCommitSourceActionProps | GitHubSourceActionProps | S3SourceActionProps

export class SourceAction extends Construct {

  public readonly action: Action
  public readonly sourceCode: Artifact
  public readonly source: Bucket | IRepository

  constructor(scope: Construct, id: string, props: SourceActionProps) {
    super(scope, id)
    const output = new Artifact('SourceCode')
    const sourceId = 'Source'
    const actionName = 'Source'
    switch(props.type) {
      case SourceType.CodeCommit:
        // ToDo: Allow setting removal policy using applyRemovalPolicy.
        const codeCommitSourceActionProps = props as CodeCommitSourceActionProps
        const repository = codeCommitSourceActionProps.create ?
          new Repository(this, sourceId, {
            repositoryName: codeCommitSourceActionProps.name,
          }) :
          Repository.fromRepositoryName(this, sourceId, codeCommitSourceActionProps.name)
        this.action = new CodeCommitSourceAction({
          actionName,
          output,
          repository,
        })
        this.source = repository
        break
      case SourceType.GitHub:
        const gitHubSourceActionProps = props as GitHubSourceActionProps
        const gitHubToken = SecretValue.secretsManager(gitHubSourceActionProps.tokenName)
        this.action = new GitHubSourceAction({
          actionName,
          output,
          oauthToken: gitHubToken,
          owner: gitHubSourceActionProps.owner,
          repo: gitHubSourceActionProps.name,
        })
        break
      case SourceType.S3:
        const s3SourceActionProps = props as S3SourceActionProps
        const removalPolicy = props.deleteSourceWithApp ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN
        const bucket = new Bucket(this, sourceId, {
          versioned: true,
          removalPolicy,
        })
        if (props.deleteSourceWithApp) {
          const entry = join(__dirname, 'custom-resource', 'empty-bucket')
          const properties = {
            bucketName: bucket.bucketName,
          }
          const emptySourceResource = new PythonResource(this, 'EmptySourceResource', {
            entry,
            properties,
          })
          bucket.grantRead(emptySourceResource)
          bucket.grantDelete(emptySourceResource)
        }
        this.action = new S3SourceAction({
          actionName,
          output,
          bucket,
          bucketKey: s3SourceActionProps.key,
        })
        this.source = bucket
        break
      default:
        throw new Error('Unsupported Type')
    }
    this.sourceCode = output
  }

}

export interface BaseBuildProps extends BasePipelineBuilderProps {
  readonly sourceCode: Artifact,
}

export interface YarnSynthActionProps extends BaseBuildProps, YarnSynthConfig {
  readonly cacheBucket: IBucket,
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
  readonly cloudAssembly: Artifact,
  readonly runOrder?: number,
  readonly cacheBucket: IBucket,
}

export function createArchiValidateAction (scope: Construct, archiValidateActionProps: ArchiValidateActionProps) {
  const prefix = archiValidateActionProps.prefix ?? 'Validate'
  const diagramsSite = new Cdn(scope, 'DiagramsSite')
  const path = join(__dirname, 'cloud-diagrams', 'index.html')
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
  readonly inRuntimes?: KeyValue,
  readonly inEnvVars?: KeyValue,
  readonly inEnvSecrets?: KeyValue,
  readonly inEnvVarArgs?: KeyValue,
  readonly inEnvSecretArgs?: KeyValue,
  readonly installCommands?: string[],
  readonly prebuildCommands?: string[],
  readonly postbuildCommands?: string[],
}

export class ImageBuildAction extends Construct {

  public readonly action: Action
  public readonly project: PipelineProject
  public readonly repo: EcrRepository

  constructor(scope: Construct, id: string, props: ImageBuildActionProps) {
    super(scope, id)
    const removalPolicy = props.deleteRepoWithApp ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN
    const repo = new EcrRepository(this, 'Repo', {
      removalPolicy,
    })
    // !ToDo: Use image assets instead of pulling from npm?
    if (props.deleteRepoWithApp) {
      const entry = join(__dirname, 'custom-resource', 'empty-repo')
      const properties = {
        imageRepoName: repo.repositoryName,
      }
      const emptyRepoResource = new PythonResource(this, 'EmptyRepoResource', {
        entry,
        properties,
      })
      // ToDo: Aggregate grant to delete.
      repo.grant(emptyRepoResource, 'ecr:ListImages', 'ecr:BatchDeleteImage')
    }
    const runtimes ={
      ...props.inRuntimes,
      ...props.runtimes,
    }
    const allRuntimes = {
      ...runtimes,
      docker: 19,
    }
    const envVarArgs ={
      ...props.inEnvVarArgs,
      ...props.envVarArgs,
    }
    const envVars = {
      ...props.inEnvVars,
      ...props.envVars,
    }
    const envSecretArgs ={
      ...props.inEnvSecretArgs,
      ...props.envSecretArgs,
    }
    const envSecrets = {
      ...props.inEnvSecrets,
      ...props.envSecrets,
    }
    const allEnvVars = {
      ...envVarArgs,
      ...envVars,
      DOCKER_BUILDKIT: 1,
    }
    const allEnvSecrets = {
      ...envSecretArgs,
      ...envSecrets,
    }
    const imageRepoTag = repo.repositoryUri + ':latest'
    const installCommands = []
    installCommands.push(...props.installCommands ?? [])
    if (props.installScript) {
      installCommands.push('. ./' + props.installScript)
    }
    const prebuildCommands = []
    prebuildCommands.push(...props.prebuildCommands ?? [])
    if (props.prebuildScript) {
      prebuildCommands.push('. ./' + props.prebuildScript)
    }
    prebuildCommands.push(
      'aws ecr get-login-password | docker login --username AWS --password-stdin ' + repo.repositoryUri,
      'docker pull ' + imageRepoTag + ' || true',
    )
    const envVarArgKeys = Object.keys(envVarArgs ?? {})
    const envSecretArgKeys = Object.keys(envSecretArgs ?? {})
    let argKeys: string[] = []
    argKeys = argKeys.concat(envVarArgKeys).concat(envSecretArgKeys)
    const buildArgs = argKeys.map(argKey => '--build-arg ' + argKey + '=${' + argKey + '}')
    const buildCommandParts = [
      'docker build --build-arg BUILDKIT_INLINE_CACHE=1',
    ].concat(buildArgs)
    buildCommandParts.push(
      '--cache-from ' + imageRepoTag + ' -t ' + imageRepoTag + ' .',
    )
    const buildCommand = buildCommandParts.join(' ')
    const postbuildCommands = []
    postbuildCommands.push(
      'docker push ' + repo.repositoryUri,
    )
    if (props.postbuildScript) {
      postbuildCommands.push('. ./' + props.postbuildScript)
    }
    postbuildCommands.push(...props.postbuildCommands ?? [])
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
    const computeType = mapCompute(props.compute)
    const linuxPrivilegedEnv = {
      computeType,
      buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
      privileged: true,
    }
    const project = new PipelineProject(this, 'Project', {
      environment: linuxPrivilegedEnv,
      buildSpec: imageSpec,
    })
    repo.grantPullPush(project)
    const actionName = 'Build'
    this.action = new CodeBuildAction({
      actionName,
      project,
      input: props.sourceCode,
    })
    this.project = project
    this.repo = repo
  }

}

export interface DroidBuildActionProps extends BaseBuildProps, DroidBuildConfig {
  readonly inRuntimes?: KeyValue,
  readonly inEnvVars?: KeyValue,
  readonly inEnvSecrets?: KeyValue,
  readonly installCommands?: string[],
  readonly prebuildCommands?: string[]
  readonly postbuildCommands?: string[]
  readonly cacheBucket: IBucket,
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
  if (droidBuildActionProps.installScript) {
    installCommands.push('. ./' + droidBuildActionProps.installScript)
  }
  const prebuildCommands = []
  prebuildCommands.push(...droidBuildActionProps.prebuildCommands ?? [])

  if (droidBuildActionProps.prebuildScript) {
    prebuildCommands.push('. ./' + droidBuildActionProps.prebuildScript)
  }
  const postbuildCommands = []
  if (droidBuildActionProps.postbuildScript) {
    postbuildCommands.push('. ./' + droidBuildActionProps.postbuildScript)
  }
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
  readonly cacheBucket: IBucket,
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
  readonly input: Artifact,
}

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

export interface PyInvokeActionProps extends BasePipelineBuilderProps {
  readonly path: string,
  readonly index?: string,
  readonly handler?: string,
  readonly params?: KeyValue,
  readonly runOrder?: number,
}

export function createPyInvokeAction (scope: Construct, pyInvokeActionProps: PyInvokeActionProps) {
  const prefix = pyInvokeActionProps.prefix ?? 'Invoke'
  const entry = join(__dirname, pyInvokeActionProps.path)
  const handlerName = prefix + 'Handler'
  const lambda = new PythonFunction(scope, handlerName, {
    entry,
    index: pyInvokeActionProps.index,
    handler: pyInvokeActionProps.handler,
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

export interface StageProps {
  readonly stageName: string,
  readonly actions: Action[],
}

export interface PipelineProps extends BasePipelineBuilderProps, BasePipelineConfig {
  readonly stages: StageProps[],
}

export function createPipeline (scope: Construct, pipelineProps: PipelineProps) {
  const prefix = pipelineProps.prefix ?? 'Pipeline'
  const artifactBucketId = prefix + 'ArtifactBucket'
  const removalPolicy = pipelineProps.deleteArtifactsWithApp ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN
  const artifactBucket = new Bucket(scope, artifactBucketId, {
    removalPolicy,
  })
  // !ToDo: Use image assets instead of pulling from npm?
  if (pipelineProps.deleteArtifactsWithApp) {
    const entry = join(__dirname, 'custom-resource', 'empty-bucket')
    const properties = {
      bucketName: artifactBucket.bucketName,
    }
    const emptyArtifactsResource = new PythonResource(scope, 'EmptyArtifactsResource', {
      entry,
      properties,
    })
    artifactBucket.grantRead(emptyArtifactsResource)
    artifactBucket.grantDelete(emptyArtifactsResource)
  }
  const name = prefix
  return new Pipeline(scope, name, {
    stages: pipelineProps.stages,
    artifactBucket,
    restartExecutionOnUpdate: pipelineProps.restartExecutionOnUpdate,
  })
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
