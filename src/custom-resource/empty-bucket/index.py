from json import dumps
from logging import getLogger, INFO
from boto3 import client
from botocore.exceptions import ClientError

logger = getLogger()
logger.setLevel(INFO)

s3 = client('s3')

def handler(event, context):
  logger.info('Received event: %s' % dumps(event))
  request_type = event['RequestType']
  if request_type == 'Create': return
  if request_type == 'Update': return
  if request_type == 'Delete': return empty_bucket(event)
  raise Exception('Invalid request type: %s' % request_type)

def empty_bucket(event):
  bucket_name = event['ResourceProperties']['bucketName']
  try:
    delete_all_objects(bucket_name)
  except ClientError as e:
    logger.error('Client Error: %s', e)
    raise e
  return

def delete_all_objects(bucket_name):
  object_versions = s3.list_object_versions(
    Bucket=bucket_name
  )
  all_object_versions = []
  while object_versions['IsTruncated']:
    if 'Versions' in object_versions:
      all_object_versions.extend(object_versions['Versions'])
    if 'DeleteMarkers' in object_versions:
      all_object_versions.extend(object_versions['DeleteMarkers'])
    object_versions = s3.list_object_versions(
      Bucket=bucket_name,
      KeyMarker=object_versions['NextKeyMarker'],
      VersionIdMarker=object_versions['NextVersionIdMarker']
    )
  if 'Versions' in object_versions:
    all_object_versions.extend(object_versions['Versions'])
  if 'DeleteMarkers' in object_versions:
    all_object_versions.extend(object_versions['DeleteMarkers'])
  for object_version in all_object_versions:
    s3.delete_object(
      Bucket=bucket_name,
      Key=object_version['Key'],
      VersionId=object_version['VersionId']
    )
  return
