import cp = require('child_process');
import tmp = require('tmp-promise');
import fs = require('fs');
import {IConfig, AppConfig} from '../../Config';
import {Commit} from '../GithubUtil';
import {Course} from '../../model/business/CourseModel';
import {Result} from '../results/ResultRecord';
import {TestJob, TestJobDeliverable} from '../../controller/TestJobController';
import DockerInput, { DockerInputJSON } from '../../model/docker/DockerInput';
import {Report} from '../../model/results/ReportRecord';
import Log from '../../Util';

const GITHUB_TIMEOUT_MSG = 'Your assignment has timed out while being tested. Please check for infinite loops' + 
  ' and slow runtime methods.';

export interface Attachment {
  name: string;
  data: any;
  content_type: string;
}

interface TestOutput {
  testStats: TestStats;
}

interface CoverageOutput {
  coverageStats: CoverageStats;
}

interface TestStats {
  passPercent: number;
  passCount: number;
  failCount: number;
  skipCount: number;
  passNames: string[];
  failNames: string[];
  skipNames: string[];
}

export interface CoverageStat {
  percentage: number;
  total: number;
  covered: number;
  skipped: number;
}
export interface CoverageStats {
  lines: CoverageStat;
  statements: CoverageStat;
  branches: CoverageStat;
  functions: CoverageStat;
}

export interface ProcessedTag {
  content: any;
  exitCode: number;
}

export interface TestInfo {
  testRecord: Result,
  containerExitCode: number,
  stdioLog: Attachment,
  processErrors: string[]
}

export default class TestRecord {
  private maxStdioSize: number = 1 * 500000;  // 500 KB
  private maxStdioLength: number = 1000000; // characters
  private shaSize: number;
  private stdio: string;
  private report: string;
  private requestor: string;
  private state: string;
  private repo: string;
  private postbackOnComplete: boolean;
  private reportSize: number;
  private stdioSize: number;
  private coverageZip: Buffer;
  private githubToken: string;
  private _id: string;
  private team: string;
  private deliverable: TestJobDeliverable;
  private courseNum: number;
  private testReport: any;
  private commit: string;
  private course: Course;
  private resultRecord: Result;
  private commitUrl: string;
  private projectUrl: string;
  private committer: string;
  private containerExitCode: number = 0;
  private timestamp: number;
  private scriptVersion: string;
  private suiteVersion: string;
  private failedCoverage: string;
  private ref: string;
  private orgName: string;
  private username: string;
  private dockerInput: DockerInputJSON;
  private dockerImage: string;
  private testRecord: Result;

  constructor(githubToken: string, testJob: TestJob) {
    this.courseNum = testJob.courseNum;
    this.course = testJob.course;
    this.githubToken = githubToken;
    this.team = testJob.team;
    this.requestor = testJob.requestor,
    this.repo = testJob.repo;
    this.state = testJob.state;
    this.postbackOnComplete = testJob.postbackOnComplete;
    this.projectUrl = testJob.projectUrl;
    this.commitUrl = testJob.commitUrl;
    this.deliverable = testJob.test;
    this.commit = testJob.commit;
    this.committer = testJob.username;
    this.ref = testJob.ref;
    this.timestamp = testJob.timestamp;
    this._id = this.timestamp + '_' + this.team + ':' + this.deliverable.deliverable + '-';
    this.orgName = testJob.orgName;
    this.username = testJob.username;
    this.dockerImage = testJob.test.dockerImage + ':master';
    this.dockerInput = testJob.test.dockerInput;
  }

  public getTeam(): string {
    return this.team;
  }

  public getCommit(): string {
    return this.commit;
  }

  public getexitCode(): number {
    return this.containerExitCode;
  }

  public getScriptVersion(): string {
    return this.scriptVersion;
  }

  public getSuiteVersion(): string {
    return this.suiteVersion;
  }

  public getDeliverable(): TestJobDeliverable {
    return this.deliverable;
  }

  public getTestReport(): any {
    return this.testReport;
  }
  
  public getTestRecord(): Result {
    return this.testRecord;
  }

  public createTestRecord(): Result {
    Log.info(`TestRecord::getTestRecord() INFO - start`);
    
    let that = this;
      this._id += this.suiteVersion;
      let container = {
        image: this.dockerImage,
        exitCode: this.containerExitCode
      }

      function getDockerInput() {
        if (that.dockerInput) {
          let attachment = {name: 'docker_SHA.json', data: that.dockerInput, content_type: 'application/json'};
          return attachment;
        } 
        return null;
      }
      
      let doc: Result;

      try {
        doc = {
          'team': this.team,
          'repo': this.repo,
          'state': this.state,
          'projectUrl': this.projectUrl,
          'commitUrl': this.commitUrl,
          'courseNum': this.courseNum,
          'orgName': this.orgName,
          'deliverable': this.deliverable.deliverable,
          'user': this.username,
          'report': null,
          'commit': this.commit,
          'committer': this.committer,
          'timestamp': this.timestamp,
          'postbackOnComplete': true, // if a timeout occurs, this error will postback by default,
          'container': container,
          'requestor': this.requestor,
          'gradeRequested': false,
          'githubFeedback': GITHUB_TIMEOUT_MSG,
          'gradeRequestedTimestamp': -1,
          'ref': this.ref,
          'stdioRef': that.dockerInput.stdioRef,
          'attachments': [getDockerInput()],
        }
        Log.info(`TestRecord::createTestRecord() INFO - Created TestRecord to save in case of Timeout on commit ${this.commit} and user ${this.username}`);
        // instead of returning, it should be entered into the Database.
      }
      catch(err) {
        Log.error(`TestRecord::createTestRecord() - ERROR ${err}`)
      }
      return doc;
    }

  public async generate(): Promise<TestInfo> {
    // this.dockerInput input will be accessible in mounted volume of Docker container as /output/docker_SHA.json
    this.testRecord = this.createTestRecord();
    let tempDir = await tmp.dir({ dir: '/tmp', unsafeCleanup: true });
    await this.writeContainerInput(tempDir, this.dockerInput, this.testRecord);    
    Log.info('TestRecord:: generate() - start - run-test-container.sh for ' + this.deliverable.deliverable + ' and ' + this.commit + '.');
    let that = this;
    let file: string = './docker/tester/run-test-container.sh';
    let args: string[] = [
      this.dockerImage,
      tempDir.path,
      process.env.NODE_ENV === 'production' ? '--env IS_CONTAINER_LIVE=1' : '--env IS_CONTAINER_LIVE=0'
    ];
    let options = {
      encoding: 'utf8'
    }

    return new Promise<TestInfo>((fulfill, reject) => {
      cp.execFile(file, args, options, (error: any, stdout, stderr) => {
        if (error) {
          Log.error('TestRecord::execFile() ERROR ' + error);
          this.containerExitCode = error.code;
        } else {
          Log.info('TestRecord::execFile() CMD: ' + file + ' ' + args[0] + ' ' + args[1] + ' ' + args[2]);
        }

        let promises: Promise<string>[] = [];
        let getTranscriptSize: Promise<string> = new Promise((fulfill, reject) => {
          fs.stat(tempDir.path + '/stdio.txt', (err, stats) => {
            if (err) {
              Log.error('TestRecord::generate() - ERROR reading stdio.txt. ' + err);
              if (this.containerExitCode == 0) this.containerExitCode = 30;
              return fulfill(err);
            }

            this.stdioSize = stats.size;
            if (stats.size > this.maxStdioSize)
              if (this.containerExitCode == 0) this.containerExitCode = 29;
            fulfill();
          });
        });
        promises.push(getTranscriptSize);

        let readTranscript: Promise<string> = new Promise((fulfill, reject) => {
          fs.readFile(tempDir.path + '/stdio.txt', 'utf8', (err, data) => {
            if (err) {
              Log.error('TestRecord::generate() - ERROR reading stdio.txt. ' + err);
              if (this.containerExitCode == 0) this.containerExitCode = 31;
              return fulfill(err);
            }
            else {
              Log.info('TestRecord::generate() - SUCCESS reading stdio.txt. ' + tempDir.path + '/output/stdio.txt');
            }
            try {
              this.stdio = data;

              // Process the info tag
              let infoTag: any = this.processInfoTag(data);
              this.scriptVersion = infoTag.scriptVersion;
              this.suiteVersion = infoTag.suiteVersion;

              fulfill();
            } catch(err) {
              fulfill(err);
            }
          });
        });
        promises.push(readTranscript);

        Promise.all(promises).then((err) => {
          
          let testInfo: TestInfo = {
            testRecord: that.getTestRecord(),
            stdioLog: that.getStdio(),
            containerExitCode: that.containerExitCode,
            processErrors: err
          }

          tempDir.cleanup();
          fulfill(testInfo);
        }).catch(err => {
          Log.error('TestRecord::generate() - ERROR processing container output. ' + err);
          if (this.containerExitCode == 0) this.containerExitCode = 39;
          reject(err);
        });
      });
    });
  }

  public processInfoTag(stdout: string): any {
    try {
      let infoTagRegex: RegExp = /^<INFO>\nproject url: (.+)\nbranch: (.+)\ncommit: (.+)\nscript version: (.+)\ntest suite version: (.+)\n<\/INFO exitCode=(\d+), completed=(.+), duration=(\d+)s>$/gm
      let matches: string[] = infoTagRegex.exec(stdout);
      let processed: any = {
        scriptVersion: matches[4].trim(),
        suiteVersion: matches[5].trim()
      };
      return processed;
    } catch (err) {
      throw 'Failed to process <INFO> tag. ' + err;
    }
  }

  public getStdio() {
    if (this.stdio && this.stdio.length > this.maxStdioLength) {
      let trimmedStdio = String(this.stdio).substring(0, this.maxStdioLength);
      trimmedStdio += "\n\n\n STDIO FILE TRUNCATED AS OVER " + this.maxStdioLength + " CHARACTER SIZE LIMIT";
      let attachment = {name: 'stdio.txt', data: trimmedStdio, content_type: 'application/plain'};
      return attachment;
    } else {
      let attachment = {name: 'stdio.txt', data: this.stdio, content_type: 'application/plain'};
      return attachment;
    }
  }

  public writeContainerInput(tmpDir: any, dockerInput: object, resultRecord: Result) {
    let that = this;
    return new Promise((fulfill, reject) => {
      try {
        Log.info(`TestRecord::writeContainerInput() Writing 'docker_SHA.json' file in container volume: ` + JSON.stringify(dockerInput));
        fs.writeFile(tmpDir.path + '/docker_SHA.json', JSON.stringify(dockerInput), (err) => {
          if (err) {
            throw err;
          } else {
            return fulfill();
          }
        });   
      } catch (err) {
        Log.error(`TestRecord::writeContainerInput() docker_SHA.json ERROR ${err}`);
      }
    })
    .then(() => {
      return new Promise((fulfill, reject) => {
        try {
          Log.info(`TestRecord::writeContainerInput() Writing 'result_record.json' file in container volume: ` + JSON.stringify(resultRecord));
          fs.writeFile(tmpDir.path + '/result_record.json', JSON.stringify(resultRecord), (err) => {
            if (err) {
              throw err;
            } else {
              return fulfill();
            }
          });   
        } catch (err) {
          Log.error(`TestRecord::writeDockerJSON() result_record.json ERROR ${err}`);
        }
      });
    });
  }
}

