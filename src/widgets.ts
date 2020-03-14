import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import process from 'process';
import mergeImages from 'merge-images';
import moment from 'moment-timezone';
import { v4 as uuid } from 'uuid';
import { ScheduledHandler } from 'aws-lambda';
import { CloudWatch } from 'aws-sdk';
import { WebClient } from '@slack/web-api';
import { ImageSource } from 'merge-images';
import { Canvas, Image } from 'canvas';

const {
  WIDGETS_NAMES,
  METRICS_X_COUNT,
  METRICS_DAYS_AGO,
  SLACK_TOKEN,
  SLACK_METRICS_CHANNEL_ID,
} = process.env;

const metricsXCount = Number(METRICS_X_COUNT!);
const metricsDaysAgo = Number(METRICS_DAYS_AGO!);

moment.locale('ja');
moment.tz.setDefault('Asia/Tokto');

/**
 * @param  {string} widgetsName
 * @returns Promise
 */
const createMetricsImage = async (widgetsName: string): Promise<string> => {
  // getMetricWidgetImage で生成される画像サイズと同値を指定
  const imageWidth = 600;
  const imageHeight = 400;

  // ダッシュボードのソースを読み込み
  const basePath = path.join(__dirname, '..', '..', '..');
  const widgetPath = path.join(basePath, 'widgets', `${widgetsName}.json`);
  const widget = await fs.readJson(widgetPath);

  const imagesDir = path.join(os.tmpdir(), uuid());
  await fs.ensureDir(imagesDir);

  const widgets: Array<any> = Array.from(
    widget.widgets ? widget.widgets : widget,
  );

  // ウィジェット毎にpng画像を生成し、マージ用元データを作成する
  const imageSources = await Promise.all(
    widgets
      .filter(widgetPart => widgetPart?.properties?.view === 'timeSeries')
      .map(async (widgetPart, index) => {
        const properties = widgetPart.properties;
        const imagePath = path.join(imagesDir, `${index}.png`);

        // +0000 形式
        const timezone = moment()
          .format('Z')
          .replace(':', '');

        const cw = new CloudWatch({
          region: properties.region,
        });

        // AWSにリクエストし、結果をファイル保存
        const output = await cw
          .getMetricWidgetImage({
            MetricWidget: JSON.stringify({
              ...properties,
              start: `-PT${metricsDaysAgo * 24}H`,
              end: 'PT0H',
              timezone,
              width: imageWidth,
              height: imageHeight,
            }),
          })
          .promise();

        await fs.writeFile(imagePath, output.MetricWidgetImage);

        // マージ用元データを作成し返却
        // 描画位置の指定をおこない、画像を metricsXCount ずつ横に並べる
        const source: ImageSource = {
          src: imagePath,
          x: imageWidth * (index % metricsXCount),
          y: imageHeight * Math.floor(index / metricsXCount),
        };

        return source;
      }),
  );

  // 画像のマージ
  // ライブラリ都合で Canvas.Image が存在しないとエラーとなったため以下指定
  const canvas: any = Canvas;
  canvas.Image = Image;

  const mergedImageBase64 = await mergeImages(imageSources, {
    Canvas: canvas,
    width: imageWidth * metricsXCount,
    height: imageHeight * Math.ceil(imageSources.length / metricsXCount),
  });

  // Base64形式からファイルに変換
  const metricsData = mergedImageBase64.replace(/^data:image\/png;base64,/, '');
  const metricsPath = path.join(imagesDir, `${widgetsName}.png`);
  await fs.writeFile(metricsPath, metricsData, 'base64');

  return metricsPath;
};

/**
 * @param  {string} widgetsName
 * @param  {string} metricsImagePath
 * @returns Promise
 */
const notifyToSlack = async (
  widgetsName: string,
  metricsImagePath: string,
): Promise<void> => {
  // 結果画像ファイルをSlackに通知する
  const webClient = new WebClient(SLACK_TOKEN);

  const file = await fs.readFile(metricsImagePath);
  const filename = path.basename(metricsImagePath);

  const startDay = moment().subtract(metricsDaysAgo, 'days');
  const endDay = moment();
  const initialComment = `*${startDay.format('YYYY/M/D')} ~ ${endDay.format(
    'YYYY/M/D',
  )}* の *${widgetsName}* のメトリクスです:chart_with_upwards_trend:`;
  const title = `metrics_${widgetsName}_${startDay.format(
    'YYYYMMDD',
  )}_${endDay.format('YYYYMMDD')}`;

  // Slackに投稿
  const result = await webClient.files.upload({
    channels: SLACK_METRICS_CHANNEL_ID,
    file,
    filename,
    title,
    // eslint-disable-next-line @typescript-eslint/camelcase
    initial_comment: initialComment,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }
};

export const scheduledHandler: ScheduledHandler = async event => {
  console.log(`event: ${event}`);
  console.log(`start.`);

  // ウィジェットファイル毎に処理をおこなう
  const widgetsNames = WIDGETS_NAMES!.split(',').map(wn => wn.trim());
  const failedWidgetsNames: Array<string> = [];

  for (const widgetsName of widgetsNames) {
    // ファイル毎にエラー処理
    try {
      console.log(`widgetsName: ${widgetsName}`);

      const metricsImagePath = await createMetricsImage(widgetsName);
      console.log('metrics image created.');

      await notifyToSlack(widgetsName, metricsImagePath);
      console.log('notified to slack.');
    } catch (e) {
      console.error('failed to notify...');
      console.error(e);
      failedWidgetsNames.push(widgetsName);
    }

    if (failedWidgetsNames.length > 0) {
      throw new Error(`failed widgets names: ${failedWidgetsNames.join(', ')}`);
    }
  }

  console.log(`finish.`);
};
