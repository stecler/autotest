/**
 * Created by steca
 * 
 * ******
 */

import Log from '../Util';
import { IConfig, AppConfig } from '../Config';
import mongodb = require('mongodb');
import db, {Database} from '../db/MongoDB';
import {Deliverable} from '../model/settings/DeliverableRecord'
import {Course} from '../model/business/CourseModel';

const COURSE_COLLECTION = 'courses';
const COURSE_ID_PROPERTY = 'courseId';
const DELIVERABLES_COLLECTION = 'deliverables';
const OBJECT_ID_PROPERTY = '_id';

export default class CourseRepo {

  private db: Database;

  constructor() {
    this.db = db;
  }

  public getCourse(courseNum: number): Promise<Course> {
    return new Promise<Course>((fulfill, resolve) => {
      let courseQuery = db.getRecord('courses', {'courseId': courseNum.toString()})
      .then((course: Course )=> {
        fulfill(course);
      });
    })
  }

}
