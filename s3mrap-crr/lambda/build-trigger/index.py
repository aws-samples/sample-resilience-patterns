import boto3
import json
import logging
import os

logger = logging.getLogger()
logger.setLevel(logging.INFO)

codebuild = boto3.client('codebuild')


def on_event(event, context):
    logger.info(f'Event: {json.dumps(event)}')
    request_type = event['RequestType']
    project_name = event['ResourceProperties']['ProjectName']
    physical_id = event.get('PhysicalResourceId', 'build-trigger')

    if request_type == 'Delete':
        # Don't run make clean via CodeBuild — child stacks are cleaned up
        # separately via 'make clean' or by destroying the bootstrap stack
        # after manually cleaning child stacks.
        logger.info('Delete request — skipping CodeBuild clean')
        return {'PhysicalResourceId': physical_id}

    # Create/Update: run deploy
    resp = codebuild.start_build(projectName=project_name)
    build_id = resp['build']['id']
    logger.info(f'Started deploy build: {build_id}')

    # Use build ID as physical resource ID so is_complete can find it
    return {
        'PhysicalResourceId': build_id,
        'Data': {'BuildId': build_id},
    }


def is_complete(event, context):
    request_type = event['RequestType']
    physical_id = event['PhysicalResourceId']

    if request_type == 'Delete':
        return {'IsComplete': True}

    # Create/Update: physical_id IS the build ID
    return _check_build(physical_id)


def _check_build(build_id):
    resp = codebuild.batch_get_builds(ids=[build_id])
    build = resp['builds'][0]
    status = build['buildStatus']
    logger.info(f'Build {build_id}: {status}')

    if status == 'SUCCEEDED':
        return {'IsComplete': True}
    elif status == 'IN_PROGRESS':
        return {'IsComplete': False}
    else:
        raise Exception(f'CodeBuild failed with status: {status}')
