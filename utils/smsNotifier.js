const AWS = require('aws-sdk');
const logger = require('./logger');

const awsRegion = process.env.AWS_REGION || 'ap-south-1';

AWS.config.update({
  region: awsRegion,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const sns = new AWS.SNS({ apiVersion: '2010-03-31' });

const normalizeIndianPhone = (phoneRaw = '') => {
  const digits = String(phoneRaw).replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length > 12 && digits.startsWith('0091')) return `+${digits.slice(2)}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
};

const contextTemplateEnvMap = {
  'self-punch-approve': 'AWS_SNS_TEMPLATE_ID_SELF_PUNCH_APPROVE',
  'self-punch-reject': 'AWS_SNS_TEMPLATE_ID_SELF_PUNCH_REJECT',
  professional_otp_login: 'AWS_SNS_TEMPLATE_ID_PROFESSIONAL_OTP',
  supervisor_otp_login: 'AWS_SNS_TEMPLATE_ID_SUPERVISOR_OTP'
};

const resolveTemplateIdForContext = (context) => {
  const contextKey = contextTemplateEnvMap[String(context || '').trim()];
  if (contextKey && process.env[contextKey]) {
    return process.env[contextKey];
  }
  return process.env.AWS_SNS_TEMPLATE_ID || null;
};

const isOtpContext = (context = '') =>
  ['professional_otp_login', 'supervisor_otp_login'].includes(String(context || '').trim());

const buildSnsMessageAttributes = (context = 'general') => {
  const attributes = {};
  attributes['AWS.SNS.SMS.SMSType'] = {
    DataType: 'String',
    StringValue: process.env.AWS_SNS_SMS_TYPE || 'Transactional'
  };
  if (process.env.AWS_SNS_SENDER_ID) {
    attributes['AWS.SNS.SMS.SenderID'] = {
      DataType: 'String',
      StringValue: process.env.AWS_SNS_SENDER_ID
    };
  }
  if (process.env.AWS_SNS_ENTITY_ID) {
    attributes['AWS.MM.SMS.EntityId'] = {
      DataType: 'String',
      StringValue: process.env.AWS_SNS_ENTITY_ID
    };
  }
  const templateId = resolveTemplateIdForContext(context);
  if (templateId) {
    attributes['AWS.MM.SMS.TemplateId'] = {
      DataType: 'String',
      StringValue: templateId
    };
  }
  return attributes;
};

const sendSms = async ({ phone, message, context = 'general' }) => {
  const destination = normalizeIndianPhone(phone);
  if (!destination) {
    throw new Error('Invalid phone number for SMS');
  }

  if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials missing for SNS SMS');
  }

  const params = {
    Message: String(message || ''),
    PhoneNumber: destination,
    MessageAttributes: buildSnsMessageAttributes(context)
  };

  try {
    const result = await sns.publish(params).promise();
    logger.info('[SMS] Sent via AWS SNS', {
      context,
      phone: destination,
      messageId: result?.MessageId || null
    });
    return result;
  } catch (error) {
    // Fallback for OTP: retry once without TemplateId if DLT template mapping is misconfigured.
    const hasTemplateId = Boolean(params?.MessageAttributes?.['AWS.MM.SMS.TemplateId']);
    if (isOtpContext(context) && hasTemplateId) {
      try {
        const retryParams = {
          ...params,
          MessageAttributes: { ...params.MessageAttributes }
        };
        delete retryParams.MessageAttributes['AWS.MM.SMS.TemplateId'];
        const retryResult = await sns.publish(retryParams).promise();
        logger.warn('[SMS] AWS SNS publish fallback succeeded without TemplateId', {
          context,
          phone: destination,
          originalError: error.message,
          messageId: retryResult?.MessageId || null
        });
        return retryResult;
      } catch (retryError) {
        logger.warn('[SMS] AWS SNS publish fallback failed', {
          context,
          phone: destination,
          originalError: error.message,
          retryError: retryError.message
        });
      }
    }

    logger.warn('[SMS] AWS SNS publish failed', {
      context,
      phone: destination,
      code: error.code || null,
      statusCode: error.statusCode || null,
      message: error.message
    });
    throw error;
  }
};

module.exports = {
  sendSms
};
