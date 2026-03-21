import json
import logging
import os
import boto3
import psycopg2
import psycopg2.extras

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _get_secret():
    sm = boto3.client('secretsmanager')
    return json.loads(sm.get_secret_value(SecretId=os.environ['DB_SECRET_ARN'])['SecretString'])


def get_read_connection():
    secret = _get_secret()
    host = os.environ.get('DB_READ_HOST', secret['host'])
    return psycopg2.connect(host=host, port=secret['port'], user=secret['username'], password=secret['password'], dbname=secret['dbname'])


def get_write_connection():
    secret = _get_secret()
    host = os.environ.get('DB_WRITE_HOST', secret['host'])
    return psycopg2.connect(host=host, port=secret['port'], user=secret['username'], password=secret['password'], dbname=secret['dbname'])


def handler(event, context):
    logger.info(f'Event: {json.dumps(event)}')

    path = event.get('path', '/')
    method = event.get('httpMethod', 'GET')
    body = json.loads(event.get('body') or '{}')
    params = event.get('queryStringParameters') or {}
    path_params = event.get('pathParameters') or {}

    try:
        if path == '/health' and method == 'GET':
            return respond(200, {'status': 'ok', 'region': os.environ.get('AWS_REGION')})

        conn = get_write_connection() if method in ('POST', 'PUT', 'DELETE') else get_read_connection()
        try:
            conn.autocommit = True
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                if path == '/orders' and method == 'POST':
                    cur.execute("SELECT sp_insert_order(%s, %s, %s) AS id",
                                (body.get('region', os.environ.get('AWS_REGION')),
                                 body.get('status', 'PENDING'),
                                 json.dumps(body.get('payload', {}))))
                    result = cur.fetchone()
                    return respond(201, {'id': str(result['id'])})

                elif path == '/orders' and method == 'GET':
                    cur.execute("SELECT * FROM sp_query_orders(%s, %s, %s)",
                                (params.get('region'), params.get('status'), params.get('since')))
                    rows = cur.fetchall()
                    return respond(200, {'orders': [serialize(r) for r in rows]})

                elif method == 'PUT' and '/status' in path:
                    order_id = path_params.get('id') or path.split('/')[2]
                    cur.execute("SELECT sp_update_order_status(%s, %s)", (order_id, body.get('status')))
                    return respond(200, {'updated': order_id})

                elif method == 'DELETE' and '/orders/' in path:
                    order_id = path_params.get('id') or path.split('/')[2]
                    cur.execute("SELECT sp_delete_order(%s)", (order_id,))
                    return respond(200, {'deleted': order_id})

                else:
                    return respond(404, {'error': 'not found'})
        finally:
            conn.close()

    except Exception as e:
        logger.error(f'Error: {e}')
        return respond(500, {'error': str(e)})


def respond(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body, default=str),
    }


def serialize(row):
    return {k: str(v) if v is not None else None for k, v in row.items()}
