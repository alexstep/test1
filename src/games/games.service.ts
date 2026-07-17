import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Game } from '@/database/entities/game.entity';
import { CreateGameDto } from './dto/create-game.dto';

@Injectable()
export class GamesService {
  constructor(
    @InjectRepository(Game) private readonly gameRepo: Repository<Game>,
  ) {}

  async create(dto: CreateGameDto) {
    const existing = await this.gameRepo.findOne({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException('Game name already exists');
    }

    const game = this.gameRepo.create({
      name: dto.name,
      description: dto.description ?? null,
    });
    const saved = await this.gameRepo.save(game);

    return {
      id: saved.id,
      name: saved.name,
      description: saved.description,
      created_at: saved.createdAt.toISOString(),
    };
  }

  async findAll() {
    const games = await this.gameRepo.find({ order: { createdAt: 'DESC' } });
    return games.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      created_at: g.createdAt.toISOString(),
    }));
  }

  async findById(id: string): Promise<Game | null> {
    return this.gameRepo.findOne({ where: { id } });
  }
}
