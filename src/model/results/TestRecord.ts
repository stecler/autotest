import cp = require('child_process');
import tmp = require('tmp-promise');
import fs = require('fs');
import {IConfig, AppConfig} from '../../Config';
import {Commit} from '../GithubUtil';
import {CouchDatabase,Database, DatabaseRecord, InsertResponse} from '../Database';
import {Result} from '../results/ResultRecord';
import {TestJob, TestJobDeliverable} from '../../controller/TestJobController';
import {Report} from '../../model/results/ReportRecord';
import Log from '../../Util';

const GITHUB_TIMEOUT_MSG = 'Your assignment has timed out while being marked. Please check for infinite loops ' + 
  ' and slow runtime functions.';

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
  containerExitCode: number,
  processErrors: string[]
}

export default class TestRecord {
  private maxStdioSize: number = 1 * 500000;  // 500 KB
  private maxStdioLength: number = 300000; // characters
  private shaSize: number;
  private stdio: string;
  private report: string;
  private repo: string;
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
  private openDate: number;
  private closeDate: number;
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
  private githubOrg: string;
  private username: string;
  private dockerInput: object;
  private idStamp: string;

  constructor(githubToken: string, testJob: TestJob) {
    this.courseNum = testJob.courseNum;
    this.githubToken = githubToken;
    this.team = testJob.team;
    this.repo = testJob.repo;
    this.projectUrl = testJob.projectUrl;
    this.commitUrl = testJob.commitUrl;
    this.deliverable = testJob.test;
    this.commit = testJob.commit;
    this.committer = testJob.username;
    this.ref = testJob.ref;
    this.openDate = testJob.openDate,
    this.closeDate = testJob.closeDate,
    this.timestamp = testJob.timestamp;
    this._id = this.timestamp + '_' + this.team + ':' + this.deliverable.deliverable + '-';
    this.githubOrg = testJob.githubOrg;
    this.username = testJob.username;
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

  // private createResultRecord() {
  //   let testJobRecord: TestRecord = {
  //     courseNum: this.courseNum,
  //     team: this.team,
  //     projectUrl: this.projectUrl,
  //     commitUrl: this.commitUrl,
  //     deliverable: this.deliverable.deliverable,
  //     commit: this.commit,
  //     ref: this.ref,
  //     timestamp: this.timestamp,
  //     githubOrg: this.githubOrg,
  //     username: this.username,
  //     dockerInput: this.dockerInput,
  //     idStamp: new Date().toUTCString() + '|' + this.ref + '|' + this.deliverable + '|' + this.username + '|' + this.repo
  //   }
  // }

  public async generate(): Promise<TestInfo> {
    // this.dockerInput input will be accessible in mounted volume of Docker container as /output/docker_SHA.json
    let tempDir = await tmp.dir({ dir: '/tmp', unsafeCleanup: true });
    await this.writeContainerInput(tempDir, this.dockerInput);    
    
    console.log(JSON.stringify(this.dockerInput));
    let file: string = './docker/tester/run-test-container.sh';
    let args: string[] = [
      this.deliverable.dockerImage + ':' + this.deliverable.dockerBuild,
      tempDir.path
    ];

    let options = {
      encoding: 'utf8'
    }

    return new Promise<TestInfo>((fulfill, reject) => {
      cp.execFile(file, args, options, (error: any, stdout, stderr) => {
        if (error) {
          console.log('Error', error);
          this.containerExitCode = error.code;
          console.log(error.code);
          console.log('test Record RESULT SHOULD BE here on timeout', this.getTestRecord());
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

              // Process the project build tags for Student and Deliverable repos, respectively
              let studentBuildTag: ProcessedTag = this.processStudentProjectBuildTag(data);

              // Process the coverage tag
              // let coverageTag: ProcessedTag = this.processCoverageTag(data);
              // this.failedCoverage = coverageTag.content;

              fulfill();
            } catch(err) {
              fulfill(err);
            }
          });
        });
        promises.push(readTranscript);

        Promise.all(promises).then((err) => {
          let testInfo: TestInfo = {
            containerExitCode: this.containerExitCode,
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
      //let infoMsgRegex: RegExp = /^(npm.*)$/gm;
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

  public processStudentProjectBuildTag(stdout: string): ProcessedTag {
    try {
      let buildTagRegex: RegExp = /^<BUILD_STUDENT_TESTS>\n([\s\S]*)<\/BUILD_STUDENT_TESTS exitCode=(\d+), completed=(.+), duration=(\d+)s>$/gm
      let buildMsgRegex: RegExp = /^(npm.*)$/gm;
      let matches: string[] = buildTagRegex.exec(stdout);
      let processed: ProcessedTag = {
        content: matches[1].replace(buildMsgRegex, '').trim(),
        exitCode: +matches[2]
      };
      return processed;
    } catch (err) {
      throw 'Failed to process <BUILD_STUDENT_TESTS> tag. ' + err;
    }
  }

  public processCoverageTag(stdout: string): ProcessedTag {
    try {
      let coverageTagRegex: RegExp = /^<PROJECT_COVERAGE>([\s\S]*)<\/PROJECT_COVERAGE exitCode=(\d+), completed=(.+), duration=(\d+)s>$/gm;
      let matches: string[] = coverageTagRegex.exec(stdout);
      let exitCode: number = +matches[2];
      if (exitCode == 0)
        return {content:'', exitCode:0};


      let content: string = matches[1];
      let failedTestsRegex: RegExp = /^  (\d+\)|  throw) [\s\S]*$/gm;
      let failedTests: string[] = failedTestsRegex.exec(content);

      return {content: failedTests[0], exitCode: exitCode};
    } catch(err) {
      throw 'Failed to process <PROJECT_COVERAGE> tag. ' + err;
    }
  }

  public writeContainerInput(tmpDir: any, dockerInput: object) {
    new Promise((fulfill, reject) => {
      try {
        Log.info(`TestRecord::writeContainerInput Writing 'docker_SHA.json' file in container volume`);
        fs.writeFile(tmpDir.path + '/docker_SHA.json', JSON.stringify(dockerInput), (err) => {
          if (err) {
            throw err;
          } else {
            return fulfill();
          }
        });   
      } catch (err) {
        Log.error(`TestRecord::writeDockerJSON() ERROR ${err}`);
      }
    });
  }

public getTestRecord(): Result {
  Log.info(`TestRecord::getTestRecord() INFO - start`);
  
  let that = this;
    this._id += this.suiteVersion;
    let container = {
      scriptVersion: this.scriptVersion,
      suiteVersion: this.suiteVersion,
      image: this.deliverable.dockerImage,
      exitCode: this.containerExitCode
    }

    function getStdio() {
      if (that.stdio && that.stdio.length > that.maxStdioLength) {
        let trimmedStdio = String(that.stdio).substring(0, that.maxStdioLength);
        trimmedStdio += "\n\n\n STDIO FILE TRUNCATED AS OVER " + that.maxStdioLength + " CHARACTER SIZE LIMIT";
        let attachment = {name: 'stdio.txt', data: trimmedStdio, content_type: 'application/plain'};
        return attachment;
      } else {
        let attachment = {name: 'stdio.txt', data: that.stdio, content_type: 'application/plain'};
        return attachment;
      }
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
        'projectUrl': this.projectUrl,
        'commitUrl': this.commitUrl,
        'courseNum': this.courseNum,
        'orgName': this.githubOrg,
        'openDate': this.openDate,
        'closeDate': this.closeDate,
        'deliverable': this.deliverable.deliverable,
        'user': this.username,
        'report': null,
        'commit': this.commit,
        'committer': this.committer,
        'timestamp': this.timestamp,
        'container': container,
        'gradeRequested': false,
        'githubOutput': GITHUB_TIMEOUT_MSG,
        'gradeRequestedTimestamp': -1,
        'ref': this.ref,
        'attachments': [getStdio(), getDockerInput()],
        'idStamp': new Date().toUTCString() + '|' + this.ref + '|' + this.deliverable + '|' + this.username + '|' + this.repo,
      }
      Log.info(`TestRecord::getTestRecord() INFO - Created TestRecord for Timeout on commit ${this.commit} and user ${this.username}`);
      // instead of returning, it should be entered into the Database.
    }
    catch(err) {
      Log.error(`TestRecord::getTestRecord() - ERROR ${err}`)
    }
    return doc;
  }
}