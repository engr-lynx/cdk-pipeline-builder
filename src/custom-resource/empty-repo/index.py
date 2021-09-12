from json import dumps
from logging import getLogger, INFO
from boto3 import client
from botocore.exceptions import ClientError

logger = getLogger()
logger.setLevel(INFO)

ecr = client('ecr')

def handler(event, context):
  logger.info('Received event: %s' % dumps(event))
  request_type = event['RequestType']
  if request_type == 'Create': return
  if request_type == 'Update': return
  if request_type == 'Delete': return empty_repo(event)
  raise Exception('Invalid request type: %s' % request_type)

def empty_repo(event):
  image_repo_name = event['ResourceProperties']['imageRepoName']
  try:
    delete_all_images(image_repo_name)
  except ClientError as e:
    logger.error('Client Error: %s', e)
    raise e
  return

def delete_all_images(repo_name):
  all_image_ids = []
  images = ecr.list_images(
    repositoryName=repo_name
  )
  while 'nextToken' in images:
    all_image_ids.extend(images['imageIds'])
    images = ecr.list_images(
      repositoryName=repo_name,
      nextToken=images['nextToken']
    )
  all_image_ids.extend(images['imageIds'])
  if all_image_ids: 
    ecr.batch_delete_image(
      repositoryName=repo_name,
      imageIds=all_image_ids
    )
  return
