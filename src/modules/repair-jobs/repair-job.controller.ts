import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import {
  CreateJobDto,
  JobApprovalDto,
  JobAssignmentDto,
  JobEstimateDto,
  JobListDto,
  JobReturnDto,
  JobTestsDto,
  JobTextDto,
  JobTransitionDto,
  JobVersionDto,
  CreateRepairMemberDto,
  RepairMemberStatusDto,
} from './repair-job.dto';
import { RepairJobService, RepairJobView, RepairTeamMember } from './repair-job.service';

@Controller('admin/repair/jobs')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception, AdminRole.Technician)
export class RepairJobController {
  constructor(private readonly jobs: RepairJobService) {}
  @Get() @Header('Cache-Control', 'private, no-store') list(
    @Query() query: JobListDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): ReturnType<RepairJobService['list']> {
    return this.jobs.list(query, admin);
  }
  @Post() create(
    @Body() input: CreateJobDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.create(input, admin);
  }
  @Get(':number') @Header('Cache-Control', 'private, no-store') get(
    @Param('number') number: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.get(number, admin);
  }
  @Patch(':number/assignment') assign(
    @Param('number') number: string,
    @Body() input: JobAssignmentDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.assign(number, input, admin);
  }
  @Post(':number/diagnosis') diagnose(
    @Param('number') number: string,
    @Body() input: JobTextDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.diagnose(number, input, admin);
  }
  @Post(':number/notes') note(
    @Param('number') number: string,
    @Body() input: JobTextDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.note(number, input, admin);
  }
  @Post(':number/estimates') estimate(
    @Param('number') number: string,
    @Body() input: JobEstimateDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.estimate(number, input, admin);
  }
  @Post(':number/approval') approve(
    @Param('number') number: string,
    @Body() input: JobApprovalDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.approve(number, input, admin);
  }
  @Post(':number/tests') test(
    @Param('number') number: string,
    @Body() input: JobTestsDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.test(number, input, admin);
  }
  @Post(':number/transitions') transition(
    @Param('number') number: string,
    @Body() input: JobTransitionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.transition(number, input, admin);
  }
  @Post(':number/handover') returnDevice(
    @Param('number') number: string,
    @Body() input: JobReturnDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.returnDevice(number, input, admin);
  }
  @Post(':number/photos')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10485760, files: 1, fields: 1 } }))
  upload(
    @Param('number') number: string,
    @Body() input: JobVersionDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.upload(number, input.expectedVersion, file, admin);
  }
  @Get(':number/photos/:id')
  @Header('Cache-Control', 'private, no-store')
  @Header('Cross-Origin-Resource-Policy', 'same-origin')
  async photo(
    @Param('number') number: string,
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<StreamableFile> {
    return new StreamableFile(await this.jobs.photo(number, id, admin), {
      type: 'image/webp',
      disposition: 'inline',
    });
  }
  @Delete(':number/photos/:id') removePhoto(
    @Param('number') number: string,
    @Param('id') id: string,
    @Body() input: JobVersionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.jobs.removePhoto(number, id, input.expectedVersion, admin);
  }
}

@Controller('admin/repair/team')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception)
export class RepairTeamController {
  constructor(private readonly jobs: RepairJobService) {}
  @Get() @Header('Cache-Control', 'private, no-store') list(
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<RepairTeamMember[]> {
    return this.jobs.team(admin);
  }
  @Post() @AdminRoles(AdminRole.Owner) @HttpCode(204) create(
    @Body() input: CreateRepairMemberDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<void> {
    return this.jobs.createMember(input, admin);
  }
  @Patch(':id') @AdminRoles(AdminRole.Owner) @HttpCode(204) status(
    @Param('id') id: string,
    @Body() input: RepairMemberStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<void> {
    return this.jobs.memberStatus(id, input, admin);
  }
}
